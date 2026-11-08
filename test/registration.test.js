import { testFetch } from '../test-support/auth-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { openStore } from '../store.js';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const tournament = (name = '대회') => ({ name, date: '2099-11-14', capacity: 2, description: '데모' });
const team = (key = 'A') => ({ name: `팀 ${key}`, representativeName: '대표자', members: Array.from({ length: 5 }, (_, i) => `선수${key}${i}#KR1`), representativeIndex: 2 });
async function start(dbPath = ':memory:') {
  const server = createServer({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; const client = testFetch(dbPath);
  return {
    close: () => new Promise(resolve => server.close(resolve)),
    async request(path = '/api/tournaments', data) {
      const res = await client(base + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return { status: res.status, body: await res.json() };
    },
  };
}
test('기존 생성·조회 + 5인 팀 자동 승인과 재조회', async () => {
  const app = await start();
  try {
    const created = await app.request('/api/tournaments', tournament()); assert.equal(created.status, 201);
    const id = created.body.id;
    const registered = await app.request(`/api/tournaments/${id}/teams`, team());
    assert.equal(registered.status, 201); assert.equal(registered.body.status, 'approved');
    const list = (await app.request()).body;
    assert.equal(list[0].teams.length, 1); assert.deepEqual(list[0].teams[0].members, team().members);
    assert.equal(list[0].teams[0].representativeIndex, 2);
    assert.equal((await app.request()).body[0].teams[0].id, registered.body.id);
  } finally { await app.close(); }
});
test('서버 검증: 인원, 빈값, 형식, 내부 중복, 대표자, 기존 ID·팀명', async () => {
  const app = await start();
  try {
    const id = (await app.request('/api/tournaments', tournament())).body.id;
    const path = `/api/tournaments/${id}/teams`;
    for (const change of [
      { members: team().members.slice(1) }, { members: [...team().members, '추가#KR1'] },
      { members: ['', ...team().members.slice(1)] }, { members: ['잘못된형식', ...team().members.slice(1)] },
      { members: [' Player#KR1 ', 'player#kr1', ...team().members.slice(2)] },
      { representativeIndex: 5 }, { representativeIndex: '0' }, { name: '' }, { representativeName: '' },
    ]) assert.equal((await app.request(path, { ...team(), ...change })).status, 400);
    assert.equal((await app.request(path, team())).status, 201);
    assert.equal((await app.request(path, { ...team('B'), name: ' 팀 A ' })).status, 409);
    assert.equal((await app.request(path, { ...team('B'), members: team().members.map(x => x.toUpperCase()) })).status, 409);
    assert.equal((await app.request()).body[0].teams.length, 1);
  } finally { await app.close(); }
});
test('동시 신청도 정원 초과 불가, 서로 다른 대회는 독립', async () => {
  const app = await start();
  try {
    const id = (await app.request('/api/tournaments', tournament())).body.id;
    const path = `/api/tournaments/${id}/teams`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => app.request(path, team(`T${i}`))));
    assert.equal(results.filter(result => result.status === 201).length, 2);
    assert.equal(results.filter(result => result.status === 409).length, 6);
    assert.equal((await app.request(path, team('extra'))).status, 409);
    const id2 = (await app.request('/api/tournaments', tournament('다른 대회'))).body.id;
    assert.equal((await app.request(`/api/tournaments/${id2}/teams`, team('T0'))).status, 201);
    assert.deepEqual((await app.request()).body.map(item => item.teams.length), [2, 1]);
  } finally { await app.close(); }
});
test('파일 저장: 서버 종료 후 재시작해도 팀·대회 유지', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-test-'));
  const dbPath = join(directory, 'test.sqlite');
  let app = await start(dbPath);
  let saved;
  try {
    const id = (await app.request('/api/tournaments', tournament())).body.id;
    await app.request(`/api/tournaments/${id}/teams`, team()); saved = (await app.request()).body;
  } finally { await app.close(); }
  app = await start(dbPath);
  try { assert.deepEqual((await app.request()).body, saved); }
  finally { await app.close(); }
});
test('모집 종료/과거/기존 대회 차단, 가져오기 멱등성과 충돌 보호', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-state-'));
  const dbPath = join(directory, 'test.sqlite');
  const store = openStore(dbPath);
  // Legacy import permits historical dates, preserving the user's old records.
  store.importLegacy([{ ...tournament(), id: 'past', date: '2020-01-01', capacity: 4 }]);
  store.close();
  const db = new DatabaseSync(dbPath);
  const closedStore = openStore(dbPath);
  const closed = closedStore.create(tournament('마감 대회')); closedStore.close();
  db.prepare('UPDATE tournaments SET payload=? WHERE id=?').run(JSON.stringify({ ...closed, teams: undefined, status: 'closed' }), closed.id);
  db.close();
  const app = await start(dbPath);
  try {
    assert.equal((await app.request('/api/tournaments/past/teams', team())).status, 409);
    assert.equal((await app.request(`/api/tournaments/${closed.id}/teams`, team())).status, 409);
    const legacy = [{ ...tournament(), id: 'legacy', capacity: 16 }];
    assert.equal((await app.request('/api/import', legacy)).status, 410);
    const importer = openStore(dbPath); importer.importLegacy(legacy); importer.importLegacy(legacy);
    assert.throws(() => importer.importLegacy([{ ...legacy[0], name: '충돌' }]), /같은 ID/); importer.close();
    assert.equal((await app.request('/api/tournaments/legacy/teams', team())).status, 409);
    assert.equal((await app.request()).body.length, 3);
    assert.equal((await app.request('/api/tournaments', { ...tournament(), capacity: 16 })).status, 400);
    assert.equal((await app.request('/api/tournaments', null)).status, 400);
    assert.equal((await app.request('/api/tournaments/missing/teams', team())).status, 404);
  } finally { await app.close(); }
});
test('2~8팀 모든 정원 설정을 서버에서 허용', async () => {
  const app = await start();
  try {
    for (let capacity = 2; capacity <= 8; capacity++) assert.equal((await app.request('/api/tournaments', { ...tournament(), capacity })).status, 201);
    for (const capacity of [1, 9, '8', 2.5]) assert.equal((await app.request('/api/tournaments', { ...tournament(), capacity })).status, 400);
  } finally { await app.close(); }
});
test('별도 Node 프로세스 재시작 후 디스크 데이터 유지', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-process-'));
  const filename = join(directory, 'test.sqlite');
  const moduleUrl = new URL('../store.js', import.meta.url).href;
  async function run(code) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', status => status === 0 ? resolve() : reject(new Error(errors))); });
    return JSON.parse(output);
  }
  const setup = `import {openStore} from ${JSON.stringify(moduleUrl)}; const s=openStore(${JSON.stringify(filename)});`;
  const saved = await run(`${setup} const t=s.create(${JSON.stringify(tournament())}); s.register(t.id,${JSON.stringify(team())}); s.register(t.id,${JSON.stringify(team('B'))}); s.closeRegistration(t.id); s.generateBracket(t.id); console.log(JSON.stringify(s.list())); s.close();`);
  const restored = await run(`${setup} console.log(JSON.stringify(s.list())); s.close();`);
  assert.deepEqual(restored, saved);
});

