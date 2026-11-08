import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';
import { openStore } from '../store.js';
import { sessionClient } from '../test-support/session-client.js';

test('실제 세션·CSRF·역할 인가 및 업무 규칙 통합 API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-auth-')), dbPath = join(directory, 'test.sqlite');
  let server, base;
  async function start() { server = createServer({ dbPath }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  await start();
  const guest = sessionClient(base), owner = sessionClient(base), stranger = sessionClient(base), a = sessionClient(base), b = sessionClient(base);
  let id, match, teamA, teamB;
  const tournament = { name: '보호 대회', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity: 2, description: '', scheduling: { startsAt: '2099-11-14T00:00:00Z', endsAt: '2099-11-15T00:00:00Z', maxConcurrent: 1, rounds: { 2: { startsAt: '2099-11-14T00:00:00Z', endsAt: '2099-11-15T00:00:00Z' } } } };
  const team = suffix => ({ name: suffix, representativeName: '대표', members: Array.from({ length: 5 }, (_, i) => `${suffix}${i}#TEST`), representativeIndex: 0 });
  try {
    await t.test('비로그인 쓰기 401, 회원가입·로그인 실제 세션·쿠키·토큰 회전', async () => {
      assert.equal((await guest.request('/api/tournaments', tournament)).status, 401);
      assert.equal((await guest.request('/api/auth/register', owner.credentials)).status, 403);
      for (const client of [owner, stranger, a, b]) { assert.equal((await client.signup()).status, 201); const before = client.cookie; const login = await client.login(); assert.equal(login.status, 200); assert.notEqual(client.cookie, before); assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/); }
      const db = new DatabaseSync(dbPath); for (const row of db.prepare('SELECT * FROM users').all()) { assert.equal(row.password_hash.length, 128); assert.equal(row.salt.length, 32); assert.notEqual(row.password_hash, owner.credentials.password); } db.close();
    });
    await t.test('CSRF 누락·틀린 토큰·타 출처·cross-site 차단, 개최자 지정은 세션 기준', async () => {
      for (const headers of [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await owner.request('/api/tournaments', tournament, headers)).status, 403);
      const result = await owner.request('/api/tournaments', { ...tournament, ownerId: stranger.user.id }); assert.equal(result.status, 201); id = result.body.id;
      assert.equal((await stranger.request(`/api/tournaments/${id}/close`, {})).status, 403);
      assert.equal((await stranger.request(`/api/tournaments/${id}/bracket`, {})).status, 403);
      assert.equal((await stranger.request(`/api/tournaments/${id}/schedule-rules`, tournament.scheduling)).status, 403);
    });
    await t.test('신청 계정이 대표자로 연결, 같은 대회 복수 팀 대표 불가, 공개 PII 제한', async () => {
      const resultA = await a.request(`/api/tournaments/${id}/teams`, { ...team('알파'), representativeUserId: b.user.id }); teamA = resultA.body;
      assert.equal(resultA.status, 201); assert.equal((await a.request(`/api/tournaments/${id}/teams`, team('복제'))).status, 409);
      const resultB = await b.request(`/api/tournaments/${id}/teams`, team('베타')); assert.equal(resultB.status, 201); teamB = resultB.body;
      const publicList = await guest.request('/api/tournaments'); const item = publicList.body.find(t => t.id === id); assert.equal(item.teams[0].members, undefined); assert.equal(item.teams[0].representativeName, undefined);
      assert.equal((await owner.request(`/api/tournaments/${id}/close`, {})).status, 200);
      const bracket = await owner.request(`/api/tournaments/${id}/bracket`, {}); assert.equal(bracket.status, 201); match = bracket.body.rounds[0].matches[0];
      assert.equal((await a.request(`/api/tournaments/${id}/bracket`, {})).status, 403);
    });
    await t.test('상대 결과·동의·운영진 사칭 차단, 양 팀 명시적 동의만 확정', async () => {
      const path = `/api/tournaments/${id}/matches/${match.id}`;
      assert.equal((await a.request(path + '/results', { teamId: teamB.id, winnerTeamId: teamA.id, score: [1, 0] })).status, 403);
      assert.equal((await a.request(path + '/schedule-proposals', { startsAt: '2099-11-14T01:00:00Z', proposer: { role: 'organizer', name: '위조' } })).status, 403);
      const proposal = await a.request(path + '/schedule-proposals', { startsAt: '2099-11-14T01:00:00Z', proposer: { role: 'team', teamId: teamA.id } }); assert.equal(proposal.status, 201);
      const consent = path + `/schedule-proposals/${proposal.body.id}/consent`;
      assert.equal((await a.request(consent, { teamId: teamB.id })).status, 403);
      assert.equal((await owner.request(consent, { teamId: teamA.id })).status, 403);
      assert.equal((await a.request(consent, { teamId: teamA.id })).body.confirmed, false);
      assert.equal((await b.request(consent, { teamId: teamB.id })).body.confirmed, true);
      const invalid = await a.request(path + '/schedule-proposals', { startsAt: '2099-11-16T01:00:00Z', proposer: { role: 'team', teamId: teamA.id } });
      const invalidConsent = path + `/schedule-proposals/${invalid.body.id}/consent`;
      await a.request(invalidConsent, { teamId: teamA.id }); assert.equal((await b.request(invalidConsent, { teamId: teamB.id })).status, 409);
    });
    await t.test('단독 미확정·분쟁 유지·일치 우승·확정 재제출 차단', async () => {
      const path = `/api/tournaments/${id}/matches/${match.id}/results`, winner = match.slots[0].teamId, other = match.slots[1].teamId;
      let result = await a.request(path, { teamId: teamA.id, winnerTeamId: winner, score: [1, 0] }); assert.equal(result.body.rounds[0].matches[0].resultStatus, 'AWAITING_CONFIRMATION');
      result = await b.request(path, { teamId: teamB.id, winnerTeamId: other, score: [0, 1] }); assert.equal(result.body.rounds[0].matches[0].resultStatus, 'DISPUTED'); assert.equal(result.body.championTeamId, undefined);
      result = await b.request(path, { teamId: teamB.id, winnerTeamId: winner, score: [1, 0] }); assert.equal(result.body.championTeamId, winner);
      assert.equal((await a.request(path, { teamId: teamA.id, winnerTeamId: other, score: [0, 1] })).status, 409);
    });
    await t.test('재시작 후 세션·권한·결과·일정 유지, 로그아웃 토큰 폐기, 만료 401', async () => {
      const oldBase = base, snapshot = (await owner.request('/api/tournaments')).body;
      await new Promise(resolve => server.close(resolve)); await start();
      const response = await fetch(base + '/api/tournaments', { headers: { Cookie: owner.cookie } }); assert.deepEqual(await response.json(), snapshot);
      const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(logout.status, 200);
      const old = await fetch(base + '/api/tournaments', { method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(tournament) }); assert.equal(old.status, 401);
      const db = new DatabaseSync(dbPath); db.exec('UPDATE sessions SET expires_at=0'); db.close();
      assert.equal((await fetch(base + '/api/tournaments', { method: 'POST', headers: { Cookie: a.cookie, 'X-CSRF-Token': a.csrf, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('기존 데이터 원문·소유자 미연결 보존 및 HTTP 읽기 전용, Secure 쿠키 설정', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-legacy-auth-')), dbPath = join(directory, 'test.sqlite');
  const store = openStore(dbPath); const item = store.create({ name: '이전 데모', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity: 2, description: '' }); store.close();
  const db = new DatabaseSync(dbPath); const original = db.prepare('SELECT payload FROM tournaments WHERE id=?').get(item.id).payload; db.close();
  const server = createServer({ dbPath }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = sessionClient(base); await client.signup(); await client.login();
    assert.equal((await client.request(`/api/tournaments/${item.id}/close`, {})).status, 403);
    assert.equal((await client.request(`/api/tournaments/${item.id}/teams`, {})).status, 403);
    assert.equal((await client.request('/api/tournaments')).body[0].permissions.legacyReadOnly, true);
    assert.equal((await client.request('/api/import', [])).status, 410);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const after = new DatabaseSync(dbPath); assert.equal(after.prepare('SELECT payload FROM tournaments WHERE id=?').get(item.id).payload, original); assert.equal(after.prepare('SELECT count(*) AS n FROM tournament_owners').get().n, 0); after.close();
  const secure = createServer({ dbPath: ':memory:', secureCookies: true }); await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
  try { const response = await fetch(`http://127.0.0.1:${secure.address().port}/api/auth/session`); assert.match(response.headers.get('set-cookie'), /; Secure/); } finally { await new Promise(resolve => secure.close(resolve)); }
});

test('잘못된 로그인과 요청 횟수 제한', async () => {
  const server = createServer({ dbPath: ':memory:' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try { const client = sessionClient(base); await client.bootstrap(); for (let i = 0; i < 15; i++) assert.equal((await client.request('/api/auth/login', { username: 'not_exists', password: '' })).status, 401); assert.equal((await client.request('/api/auth/login', { username: 'not_exists', password: '' })).status, 429); } finally { await new Promise(resolve => server.close(resolve)); }
});
