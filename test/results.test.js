import { testFetch } from '../test-support/auth-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server.js';
import { openStore } from '../store.js';

function fixture(count = 2, format = 'Bo1', dbPath = ':memory:') {
  const store = openStore(dbPath);
  const item = store.create({ name: '결과 검증', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity: count, description: '', finalFormat: format });
  for (let i = 0; i < count; i++) store.register(item.id, { name: `팀${i}`, representativeName: '대표', members: Array.from({ length: 5 }, (_, j) => `선수${i}-${j}#KR1`), representativeIndex: 0 });
  store.closeRegistration(item.id); store.generateBracket(item.id); store.close();
  return item.id;
}
async function start(count = 2, format = 'Bo1', dbPath) {
  const directory = dbPath ? null : await mkdtemp(join(tmpdir(), 'knu-results-'));
  dbPath ??= join(directory, 'test.sqlite');
  const id = fixture(count, format, dbPath);
  const server = createServer({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; const client = testFetch(dbPath);
  return {
    id, dbPath,
    close: () => new Promise(resolve => server.close(resolve)),
    async get() { return (await (await client(base + '/api/tournaments')).json()).find(t => t.id === id).bracket; },
    async submit(match, teamIndex = 0, winnerIndex = 0, score = winnerIndex ? [0, 1] : [1, 0], override = {}) {
      const response = await client(`${base}/api/tournaments/${id}/matches/${match.id}/results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId: match.slots[teamIndex].teamId, winnerTeamId: match.slots[winnerIndex].teamId, score, ...override }) });
      return { status: response.status, body: await response.json() };
    },
  };
}
const matches = bracket => bracket.rounds.flatMap(round => round.matches);
test('Bo1: 한 팀만 제출하면 미확정, 양 팀 일치 시 우승, 재제출 차단', async () => {
  const app = await start();
  try {
    const match = (await app.get()).rounds[0].matches[0]; assert.equal(match.resultStatus, 'PENDING');
    let result = await app.submit(match); assert.equal(result.status, 200);
    let saved = result.body.rounds[0].matches[0]; assert.equal(saved.resultStatus, 'AWAITING_CONFIRMATION'); assert.equal(saved.winnerTeamId, null); assert.equal(result.body.championTeamId, undefined);
    assert.equal((await app.submit(match)).status, 409);
    result = await app.submit(match, 1); saved = result.body.rounds[0].matches[0];
    assert.equal(saved.resultStatus, 'CONFIRMED'); assert.equal(saved.countsAsPlayed, true); assert.equal(saved.advancementReason, 'match_result'); assert.equal(result.body.championTeamId, match.slots[0].teamId);
    const snapshot = await app.get(); assert.equal((await app.submit(match, 1, 1)).status, 409); assert.deepEqual(await app.get(), snapshot);
  } finally { await app.close(); }
});
test('불일치 분쟁은 진출 금지, 확정 전 수정 이력 보존 및 일치 시 지정 슬롯 진출', async () => {
  const app = await start(4);
  try {
    const bracket = await app.get(); const match = bracket.rounds[0].matches[0];
    await app.submit(match, 0, 0); let result = await app.submit(match, 1, 1);
    let saved = matches(result.body).find(m => m.id === match.id); assert.equal(saved.resultStatus, 'DISPUTED'); assert.equal(saved.winnerTeamId, null);
    assert.equal(matches(result.body).find(m => m.id === match.nextMatchId).slots[match.nextSlotIndex].teamId, null);
    result = await app.submit(match, 1, 0); saved = matches(result.body).find(m => m.id === match.id);
    assert.equal(saved.resultStatus, 'CONFIRMED'); assert.equal(saved.submissionHistory.length, 3);
    const next = matches(result.body).find(m => m.id === match.nextMatchId);
    assert.equal(next.slots[match.nextSlotIndex].teamId, match.slots[0].teamId); assert.equal(next.slots[1 - match.nextSlotIndex].teamId, null);
    assert.deepEqual(result.body.rounds[0].matches[1], bracket.rounds[0].matches[1]);
  } finally { await app.close(); }
});
test('8팀 8강→준결승→결승 전체 진행, 다른 확정 경기 불변', async () => {
  const app = await start(8);
  try {
    let bracket = await app.get(); const completed = new Map();
    for (let round = 0; round < 3; round++) {
      for (const match of bracket.rounds[round].matches) {
        assert.ok(match.slots.every(slot => slot.teamId));
        assert.equal((await app.submit(match, 0)).status, 200);
        const result = await app.submit(match, 1); assert.equal(result.status, 200); bracket = result.body;
        for (const [id, before] of completed) assert.deepEqual(matches(bracket).find(m => m.id === id), before);
        completed.set(match.id, matches(bracket).find(m => m.id === match.id));
      }
    }
    assert.equal(completed.size, 7); assert.ok(bracket.championTeamId); assert.ok(bracket.completedAt);
  } finally { await app.close(); }
});
test('BYE·진출팀 미정·무관한 팀/승자·잘못된 Bo1 점수 서버 차단', async () => {
  const app = await start(3);
  try {
    const bracket = await app.get(); const bye = matches(bracket).find(m => m.status === 'bye');
    assert.equal((await app.submit(bye)).status, 409); assert.equal(bye.countsAsPlayed, false);
    const final = bracket.rounds.at(-1).matches[0];
    const knownSlot = final.slots.findIndex(slot => slot.teamId);
    assert.equal((await app.submit(final, knownSlot, knownSlot, knownSlot ? [0, 1] : [1, 0])).status, 409);
    const match = bracket.rounds[0].matches.find(m => m.status !== 'bye');
    for (const override of [{ teamId: 'not-a-team' }, { winnerTeamId: 'not-a-team' }, { score: [2, 0] }, { score: [1, 1] }, { score: [0, 1] }, { score: ['1', 0] }, { score: [-1, 0] }, { score: [1] }]) assert.equal((await app.submit(match, 0, 0, [1, 0], override)).status, override.teamId ? 403 : 400);
    assert.deepEqual(await app.get(), bracket);
  } finally { await app.close(); }
});
test('Bo3 점수 일치도 필요: 2:0/2:1 불일치는 분쟁, 2승 우승 확정', async () => {
  const app = await start(2, 'Bo3');
  try {
    const match = (await app.get()).rounds[0].matches[0];
    for (const score of [[1, 0], [2, 2], [3, 0], [2, -1]]) assert.equal((await app.submit(match, 0, 0, score)).status, 400);
    await app.submit(match, 0, 0, [2, 0]); let result = await app.submit(match, 1, 0, [2, 1]);
    assert.equal(result.body.rounds[0].matches[0].resultStatus, 'DISPUTED'); assert.equal(result.body.championTeamId, undefined);
    result = await app.submit(match, 0, 0, [2, 1]); assert.equal(result.body.championTeamId, match.slots[0].teamId); assert.deepEqual(result.body.rounds[0].matches[0].score, [2, 1]);
  } finally { await app.close(); }
});
test('동시 제출·중복 요청은 한 번만 확정하며 이중 진출 없음', async () => {
  const app = await start(4);
  try {
    const match = (await app.get()).rounds[0].matches[0];
    const responses = await Promise.all([app.submit(match, 0), app.submit(match, 1), app.submit(match, 1), app.submit(match, 0)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 409, 409]);
    const bracket = await app.get(); const saved = matches(bracket).find(m => m.id === match.id);
    assert.equal(saved.submissionHistory.length, 2);
    const next = matches(bracket).find(m => m.id === match.nextMatchId);
    assert.equal(next.slots.filter(slot => slot.teamId === match.slots[0].teamId).length, 1);
  } finally { await app.close(); }
});
test('서버/별도 프로세스 재시작 후 단일 제출·확정 결과 유지', async () => {
  const app = await start(); const id = app.id; let saved;
  try {
    const match = (await app.get()).rounds[0].matches[0]; await app.submit(match, 0);
    let reopened = openStore(app.dbPath); assert.deepEqual(reopened.list().find(t => t.id === id).bracket, await app.get()); reopened.close();
    await app.submit(match, 1); saved = await app.get();
  } finally { await app.close(); }
  const store = openStore(app.dbPath); assert.deepEqual(store.list().find(t => t.id === id).bracket, saved); store.close();
  const code = `import {openStore} from ${JSON.stringify(new URL('../store.js', import.meta.url).href)};const s=openStore(${JSON.stringify(app.dbPath)});console.log(JSON.stringify(s.list()));s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).find(t => t.id === id).bracket, saved);
});
test('기존 3단계 대진표 호환, 진출 충돌 시 제출·확정 전체 롤백', async () => {
  const app = await start(4); const id = app.id;
  try {
    const bracket = await app.get(); const match = bracket.rounds[0].matches[0];
    const db = new DatabaseSync(app.dbPath);
    for (const m of matches(bracket)) { delete m.resultStatus; delete m.submissions; delete m.submissionHistory; }
    db.prepare('UPDATE brackets SET payload=? WHERE tournament_id=?').run(JSON.stringify(bracket), id);
    assert.equal((await app.submit(match, 0)).status, 200);
    const conflict = await app.get(); matches(conflict).find(m => m.id === match.nextMatchId).slots[match.nextSlotIndex].teamId = 'conflicting-team';
    db.prepare('UPDATE brackets SET payload=? WHERE tournament_id=?').run(JSON.stringify(conflict), id);
    assert.equal((await app.submit(match, 1)).status, 409); assert.deepEqual(await app.get(), conflict); db.close();
  } finally { await app.close(); }
});

