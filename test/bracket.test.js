import { testFetch } from '../test-support/auth-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';
import { openStore } from '../store.js';
import { buildBracket } from '../bracket.js';

const input = capacity => ({ name: '대진표 시연', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity, description: '' });
const team = index => ({ name: `팀 ${index}`, representativeName: '대표', members: Array.from({ length: 5 }, (_, member) => `선수${index}-${member}#KR1`), representativeIndex: 0 });
async function start(dbPath = ':memory:') {
  const server = createServer({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; const client = testFetch(dbPath);
  return {
    close: () => new Promise(resolve => server.close(resolve)),
    async request(path = '/api/tournaments', data, method) {
      const response = await client(base + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json() };
    },
  };
}
async function seed(app, count, options = {}) {
  const result = await app.request('/api/tournaments', { ...input(Math.max(2, count)), ...options });
  assert.equal(result.status, 201);
  const path = `/api/tournaments/${result.body.id}`;
  for (let index = 0; index < count; index++) assert.equal((await app.request(`${path}/teams`, team(index))).status, 201);
  return path;
}
function verify(bracket, count) {
  const size = 2 ** Math.ceil(Math.log2(count));
  assert.equal(bracket.size, size);
  const all = bracket.rounds.flatMap(round => round.matches);
  assert.equal(all.length, size - 1);
  const first = bracket.rounds[0].matches;
  const teamIds = first.flatMap(match => match.slots.map(slot => slot.teamId)).filter(Boolean);
  assert.equal(teamIds.length, count); assert.equal(new Set(teamIds).size, count);
  assert.deepEqual(new Set(teamIds), new Set(bracket.teams.map(team => team.id)));
  const byes = all.filter(match => match.status === 'bye');
  assert.equal(byes.length, size - count);
  for (const match of all) {
    assert.ok(match.slots.filter(slot => slot.isBye).length <= 1);
    if (match.status === 'bye') {
      assert.ok(match.winnerTeamId); assert.equal(match.advancementReason, 'bye'); assert.equal(match.countsAsPlayed, false);
      assert.equal(match.slots.filter(slot => slot.isBye).length, 1);
    } else { assert.equal(match.status, 'waiting'); assert.equal(match.winnerTeamId, null); }
    if (match.nextMatchId) {
      const next = all.find(item => item.id === match.nextMatchId);
      assert.equal(next.round, match.round + 1);
      assert.equal(next.slots[match.nextSlotIndex].sourceMatchId, match.id);
      assert.equal(next.slots[match.nextSlotIndex].teamId, match.winnerTeamId);
    } else { assert.equal(match.round, bracket.rounds.length); assert.equal(match.nextSlotIndex, null); }
  }
  assert.equal(bracket.rounds.at(-1).label, '결승');
}
test('0·1팀 및 모집 중 대회는 마감/대진표 생성 불가', async () => {
  const app = await start();
  try {
    for (const count of [0, 1]) {
      const path = await seed(app, count);
      assert.equal((await app.request(`${path}/close`, {})).status, 409);
      assert.equal((await app.request(`${path}/bracket`, {})).status, 409);
    }
    const path = await seed(app, 2);
    assert.equal((await app.request(`${path}/bracket`, {})).status, 409);
  } finally { await app.close(); }
});
for (const count of [2, 3, 4, 5, 6, 7, 8]) {
  test(`${count}팀 API: 마감 → 무작위 대진 생성, BYE와 라운드 연결`, async () => {
    const app = await start();
    try {
      const path = await seed(app, count);
      assert.equal((await app.request(`${path}/close`, {})).status, 200);
      const result = await app.request(`${path}/bracket`, {}); assert.equal(result.status, 201);
      verify(result.body, count);
      assert.deepEqual((await app.request()).body[0].bracket, result.body);
      assert.equal((await app.request()).body[0].teams.length, count);
      if (count === 2) assert.deepEqual(result.body.rounds.map(round => round.matches.length), [1]);
      if (count === 8) {
        assert.deepEqual(result.body.rounds.map(round => round.matches.length), [4, 2, 1]);
        assert.deepEqual(result.body.rounds.map(round => round.label), ['8강', '준결승', '결승']);
      }
    } finally { await app.close(); }
  });
}
test('동시 생성 경쟁, 중복 생성·위치 지정·수정·추가 참가 차단, 원본 불변', async () => {
  const app = await start();
  try {
    const path = await seed(app, 3, { capacity: 8, kind: 'friendly', earlyCloseMinTeams: 3 });
    assert.equal((await app.request(`${path}/close`, {})).status, 200);
    const results = await Promise.all(Array.from({ length: 5 }, () => app.request(`${path}/bracket`, {})));
    assert.equal(results.filter(result => result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 409).length, 4);
    const original = (await app.request()).body[0];
    assert.equal((await app.request(`${path}/bracket`, {})).status, 409);
    assert.equal((await app.request(`${path}/bracket`, { slots: [] })).status, 400);
    assert.equal((await app.request(`${path}/bracket`, {}, 'PUT')).status, 405);
    assert.equal((await app.request(`${path}/bracket`, {}, 'PATCH')).status, 405);
    assert.equal((await app.request(`${path}/teams`, team('追加'))).status, 409);
    assert.equal((await app.request(`${path}/close`, {})).status, 409);
    assert.deepEqual((await app.request()).body[0], original);
  } finally { await app.close(); }
});
test('사전 공지된 친선 조기 마감만 허용, 일반/기존 대회 임의 마감 불가', async () => {
  const app = await start();
  try {
    const normal = await seed(app, 2, { capacity: 8 });
    assert.equal((await app.request(`${normal}/close`, {})).status, 409);
    assert.equal((await app.request(`${normal}/close`, { kind: 'friendly', earlyCloseMinTeams: 2 })).status, 400);
    const friendly = await seed(app, 2, { capacity: 8, kind: 'friendly', earlyCloseMinTeams: 3 });
    assert.equal((await app.request(`${friendly}/close`, {})).status, 409);
    assert.equal((await app.request(`${friendly}/teams`, team(2))).status, 201);
    assert.equal((await app.request(`${friendly}/close`, {})).status, 200);
    assert.equal((await app.request(`${friendly}/teams`, team(3))).status, 409);
    assert.equal((await app.request('/api/tournaments', { ...input(8), earlyCloseMinTeams: 2 })).status, 400);
    assert.equal((await app.request('/api/tournaments', { ...input(2), kind: 'friendly', earlyCloseMinTeams: 3 })).status, 400);
  } finally { await app.close(); }
});
test('대회 날짜 경과 시 기존 대회도 참가팀 유지하며 마감 가능', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-expired-'));
  const dbPath = join(directory, 'test.sqlite');
  const store = openStore(dbPath); const item = store.create(input(8));
  store.register(item.id, team(0)); store.register(item.id, team(1)); store.close();
  const db = new DatabaseSync(dbPath);
  const payload = JSON.parse(db.prepare('SELECT payload FROM tournaments WHERE id=?').get(item.id).payload);
  // Simulate an existing pre-stage-3 record and passage of time, only in a temp DB.
  delete payload.kind; delete payload.earlyCloseMinTeams; payload.date = '2020-01-01';
  db.prepare('UPDATE tournaments SET payload=? WHERE id=?').run(JSON.stringify(payload), item.id); db.close();
  const app = await start(dbPath);
  try {
    const path = `/api/tournaments/${item.id}`;
    assert.equal((await app.request(`${path}/close`, {})).status, 200);
    assert.equal((await app.request(`${path}/bracket`, {})).status, 201);
    assert.equal((await app.request()).body[0].teams.length, 2);
  } finally { await app.close(); }
});
test('대진표 재조회·서버 재시작, 기존 테이블/팀 보존', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-bracket-'));
  const dbPath = join(directory, 'test.sqlite');
  let app = await start(dbPath); let original; let path;
  try {
    path = await seed(app, 5); await app.request(`${path}/close`, {}); await app.request(`${path}/bracket`, {});
    original = (await app.request()).body;
    assert.deepEqual((await app.request()).body, original);
  } finally { await app.close(); }
  app = await start(dbPath);
  try {
    assert.deepEqual((await app.request()).body, original);
    assert.equal((await app.request(`${path}/bracket`, {})).status, 409);
  } finally { await app.close(); }
});
test('무작위 배치 반복 검사: 모든 팀 보존, BYE 대 BYE 없음, 링크 불변식', () => {
  for (let count = 2; count <= 8; count++) {
    const teams = Array.from({ length: count }, (_, index) => ({ id: String(index), name: `팀 ${index}` }));
    for (let repeat = 0; repeat < 30; repeat++) verify(buildBracket(teams), count);
  }
});
test('2단계 DB에 대진표 테이블만 추가, 기존 행·팀 정보 그대로 보존', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-upgrade-'));
  const dbPath = join(directory, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tournaments (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE teams (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id), payload TEXT NOT NULL);');
  const old = { ...input(2), id: 'old', status: 'open', type: 'LoL', finalFormat: 'Bo3' };
  db.prepare('INSERT INTO tournaments VALUES (?, ?)').run(old.id, JSON.stringify(old));
  for (let i = 0; i < 2; i++) db.prepare('INSERT INTO teams VALUES (?, ?, ?)').run(`old-team-${i}`, old.id, JSON.stringify({ ...team(i), id: `old-team-${i}`, status: 'approved' }));
  db.close();
  const app = await start(dbPath);
  try {
    const saved = (await app.request()).body[0];
    for (const key of Object.keys(old)) assert.deepEqual(saved[key], old[key]);
    assert.equal(saved.teams.length, 2); assert.equal(saved.bracket, null);
    assert.equal((await app.request('/api/tournaments/old/close', {})).status, 200);
    assert.equal((await app.request('/api/tournaments/old/bracket', {})).status, 201);
    assert.deepEqual((await app.request()).body[0].teams, saved.teams);
    assert.equal((await app.request()).body[0].finalFormat, 'Bo3');
  } finally { await app.close(); }
});
test('별도 서버 DB 연결에서도 같은 대회 대진표는 한 번만 생성', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-race-'));
  const dbPath = join(directory, 'test.sqlite');
  const first = await start(dbPath); const second = await start(dbPath);
  try {
    const path = await seed(first, 2); await first.request(`${path}/close`, {});
    const results = await Promise.all([first.request(`${path}/bracket`, {}), second.request(`${path}/bracket`, {})]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.deepEqual((await first.request()).body, (await second.request()).body);
  } finally { await first.close(); await second.close(); }
});

