import { testFetch } from '../test-support/auth-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { openStore } from '../store.js';
import { scheduleConflict } from '../scheduling.js';

const at = hour => new Date(Date.UTC(2099, 10, 14, hour)).toISOString();
function rules(maxConcurrent = 2) { return { startsAt: at(0), endsAt: at(24), maxConcurrent, rounds: Object.fromEntries([2, 4, 8].map(size => [size, { startsAt: at(0), endsAt: at(24) }])) }; }
async function setup(count = 4, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'knu-schedule-')), dbPath = join(directory, 'test.sqlite');
  const store = openStore(dbPath), item = store.create({ name: '일정 검증', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity: count, description: '', scheduling: options.rules ?? rules(), finalFormat: options.format ?? 'Bo1' });
  for (let i = 0; i < count; i++) store.register(item.id, { name: `팀${i}`, representativeName: '대표', members: Array.from({ length: 5 }, (_, j) => `일정선수${i}-${j}#KR1`), representativeIndex: 0 });
  store.closeRegistration(item.id); store.generateBracket(item.id); store.close();
  let server, base; const client = testFetch(dbPath);
  async function start() { server = createServer({ dbPath }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  await start(); const prefix = `/api/tournaments/${item.id}`;
  async function request(path, data) { const res = await client(base + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: res.status, body: await res.json() }; }
  return {
    id: item.id, dbPath, request, prefix,
    get: async () => (await request('/api/tournaments')).body.find(t => t.id === item.id),
    propose: (match, startsAt = at(1), proposer = { role: 'organizer', name: '데모 운영진' }) => request(`${prefix}/matches/${match.id}/schedule-proposals`, { startsAt, proposer }),
    consent: (match, proposal, teamId, decline = false) => request(`${prefix}/matches/${match.id}/schedule-proposals/${proposal.id}/${decline ? 'decline' : 'consent'}`, { teamId }),
    close: () => new Promise(resolve => server.close(resolve)),
    async restart() { await new Promise(resolve => server.close(resolve)); await start(); },
  };
}
const all = item => item.bracket.rounds.flatMap(round => round.matches);
async function agree(app, match, startsAt = at(1)) {
  const proposal = (await app.propose(match, startsAt)).body;
  assert.equal((await app.consent(match, proposal, match.slots[0].teamId)).status, 200);
  return app.consent(match, proposal, match.slots[1].teamId);
}
test('명시적 한 팀 동의는 대기, 양 팀 동의 즉시 공식 확정·예상 종료 저장', async () => {
  const app = await setup();
  try {
    const match = all(await app.get())[0], proposal = (await app.propose(match)).body;
    assert.deepEqual(proposal.approvals, []); assert.equal(proposal.status, 'PENDING');
    assert.equal((await app.consent(match, proposal, match.slots[0].teamId)).status, 200);
    assert.equal(all(await app.get())[0].schedule, undefined);
    const result = await app.consent(match, proposal, match.slots[1].teamId);
    assert.equal(result.status, 200); assert.equal(result.body.confirmed, true);
    assert.equal(result.body.schedule.durationMinutes, 90);
    assert.equal(Date.parse(result.body.schedule.endsAt) - Date.parse(result.body.schedule.startsAt), 90 * 60000);
    assert.equal(all(await app.get())[0].scheduleHistory.length, 1);
  } finally { await app.close(); }
});
test('대회·라운드 밖 또는 예상 종료 초과 거부, 구체적 사유 보존', async () => {
  const narrow = rules(); narrow.rounds[4] = { startsAt: at(2), endsAt: at(5) };
  const app = await setup(4, { rules: narrow });
  try {
    const match = all(await app.get())[0];
    for (const [hour, reason] of [[-1, '대회'], [23, '대회'], [1, '라운드'], [4, '라운드']]) {
      const result = await agree(app, match, at(hour)); assert.equal(result.status, 409); assert.ok(result.body.error.includes(reason));
      const saved = all(await app.get())[0]; assert.equal(saved.schedule, undefined); assert.equal(saved.scheduleProposals.at(-1).status, 'REJECTED'); assert.equal(saved.scheduleChangeCount, undefined);
    }
    assert.equal((await agree(app, match, at(2))).status, 200);
  } finally { await app.close(); }
});
test('동시 확정 경쟁은 정원 내 1경기만 성공, 다른 경기 일정 불변, 끝=시작 허용', async () => {
  const app = await setup(4, { rules: rules(1) });
  try {
    const [first, second] = all(await app.get());
    const a = (await app.propose(first)).body, b = (await app.propose(second)).body;
    await app.consent(first, a, first.slots[0].teamId); await app.consent(second, b, second.slots[0].teamId);
    const results = await Promise.all([app.consent(first, a, first.slots[1].teamId), app.consent(second, b, second.slots[1].teamId)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const saved = all(await app.get()), accepted = saved.find(m => m.schedule), rejected = saved.find(m => m.scheduleProposals?.[0]?.status === 'REJECTED');
    assert.ok(rejected.scheduleProposals[0].rejectionReason.includes('동시'));
    const snapshot = structuredClone(accepted);
    assert.equal((await agree(app, rejected, accepted.schedule.endsAt)).status, 200);
    assert.deepEqual(all(await app.get()).find(m => m.id === accepted.id), snapshot);
  } finally { await app.close(); }
});
test('변경은 양 팀 재동의로 1회만 차감, 거절·제안·검증 실패는 차감 안 함', async () => {
  const app = await setup(2);
  try {
    const match = all(await app.get())[0]; await agree(app, match); const initial = all(await app.get())[0].schedule;
    const declined = (await app.propose(match, at(3))).body;
    await app.consent(match, declined, match.slots[0].teamId, true);
    assert.equal(all(await app.get())[0].scheduleChangeCount, 0);
    assert.equal((await agree(app, match, at(23))).status, 409); assert.equal(all(await app.get())[0].scheduleChangeCount, 0);
    const change = (await app.propose(match, at(4))).body;
    await app.consent(match, change, match.slots[0].teamId);
    assert.deepEqual(all(await app.get())[0].schedule, initial); assert.equal(all(await app.get())[0].scheduleChangeCount, 0);
    assert.equal((await app.consent(match, change, match.slots[1].teamId)).status, 200);
    const saved = all(await app.get())[0]; assert.equal(saved.scheduleChangeCount, 1); assert.equal(saved.scheduleHistory.length, 2); assert.equal(saved.scheduleHistory[0].startsAt, initial.startsAt);
    assert.equal((await app.propose(match, at(5))).status, 409);
    assert.deepEqual(all(await app.get())[0], saved);
  } finally { await app.close(); }
});
test('미정 팀 공식 확정·BYE·무관한 팀·운영진 대리 동의·중복 동의 거부', async () => {
  const app = await setup(3);
  try {
    const matches = all(await app.get()), bye = matches.find(m => m.status === 'bye'), final = matches.at(-1), match = matches.find(m => m.status !== 'bye');
    assert.equal((await app.propose(bye)).status, 409);
    const future = (await app.propose(final)).body; const ready = final.slots.find(slot => slot.teamId).teamId;
    assert.equal((await app.consent(final, future, ready)).status, 409);
    assert.equal((await app.propose(match, at(1), { role: 'team', teamId: 'other' })).status, 403);
    const proposal = (await app.propose(match)).body;
    assert.equal((await app.consent(match, proposal, 'other')).status, 403);
    assert.equal((await app.request(`${app.prefix}/matches/${match.id}/schedule-proposals/${proposal.id}/consent`, { role: 'organizer', teamId: match.slots[0].teamId })).status, 400);
    await app.consent(match, proposal, match.slots[0].teamId);
    assert.equal((await app.consent(match, proposal, match.slots[0].teamId)).status, 409);
  } finally { await app.close(); }
});
test('선행·후속 순서 및 동일 팀 충돌 검사, Bo3는 210분', async () => {
  const app = await setup(4, { format: 'Bo3' });
  try {
    let item = await app.get(); const [a, b] = item.bracket.rounds[0].matches;
    await agree(app, a, at(1)); await agree(app, b, at(1));
    const store = openStore(app.dbPath);
    for (const match of [a, b]) for (const slot of match.slots) store.submitResult(app.id, match.id, { teamId: slot.teamId, winnerTeamId: match.slots[0].teamId, score: [1, 0] });
    store.close(); item = await app.get(); const final = item.bracket.rounds.at(-1).matches[0];
    const early = await agree(app, final, at(2)); assert.equal(early.status, 409); assert.ok(early.body.error.includes('선행'));
    assert.equal((await agree(app, final, at(3))).status, 200);
    item = await app.get(); const official = all(item).find(m => m.id === final.id).schedule; assert.equal(official.durationMinutes, 210);
    const lateParent = await agree(app, a, at(3)); assert.equal(lateParent.status, 409); assert.ok(lateParent.body.error.includes('후속'));
    // Direct conflict validator test for independent same-team matches (not parent/child).
    const copy = structuredClone(item); const first = all(copy)[0], second = all(copy)[1]; second.slots[0].teamId = first.slots[0].teamId;
    assert.ok(scheduleConflict(copy, first, at(1)).includes('같은 참가팀'));
    assert.deepEqual(all(await app.get()).find(m => m.id === final.id).schedule, official);
  } finally { await app.close(); }
});
test('경쟁 후보는 이전 revision 무효화, 재시작 후 제안·일정·변경 이력 유지', async () => {
  const app = await setup(2);
  try {
    const match = all(await app.get())[0], stale = (await app.propose(match, at(2))).body;
    await agree(app, match, at(1));
    assert.equal((await app.consent(match, stale, match.slots[0].teamId)).status, 409);
    const saved = await app.get(); await app.restart(); assert.deepEqual(await app.get(), saved);
    const extra = (await app.propose(match, at(4))).body; await app.consent(match, extra, match.slots[0].teamId); const pending = await app.get();
    await app.restart(); assert.deepEqual(await app.get(), pending);
  } finally { await app.close(); }
});
test('기존 규칙 미설정 대회 호환, 한 번 초기화 후 변경 금지, 잘못된 규칙 거부', async () => {
  const app = await setup();
  try {
    const legacy = await app.request('/api/tournaments', { name: '기존 형태', date: '2099-11-14', startsAt: '2099-11-14T00:00:00Z', recruitEndAt: '2099-11-13T00:00:00Z', capacity: 2, description: '' });
    const path = `/api/tournaments/${legacy.body.id}/schedule-rules`;
    assert.equal(legacy.body.scheduling, null);
    for (const bad of [{ ...rules(), maxConcurrent: 0 }, { ...rules(), endsAt: at(-1) }, { ...rules(), rounds: {} }]) assert.equal((await app.request(path, bad)).status, 400);
    assert.equal((await app.request(path, rules())).status, 200); assert.equal((await app.request(path, rules(4))).status, 409);
  } finally { await app.close(); }
});

