import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openStore } from '../store.js';
import { pointStorage, migratePoints } from '../points.js';
import { immediateTransaction } from '../transaction.js';

const credit = (key, delta = 10, userId = 'u') => ({ userId, delta, type: 'CREDIT', reason: 'Isolated ledger test', policyVersion: 'test-v1', idempotencyKey: key });
async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'knu-points-')), 'test.sqlite');
  const store = openStore(path);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  for (const id of ['u', 'v']) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, id, id, 'test-only-salt', 'test-only-hash', 1);
  return { path, store, db, points: pointStorage(db), close() { db.close(); store.close(); } };
}

test('Point ledger: isolated storage, validation, migration and rollback', async t => {
  const f = await fixture(), { db, points } = f;
  const ledgerCount = () => db.prepare('SELECT count(*) AS n FROM point_transactions').get().n;
  try {
    await t.test('Legacy user reads zero without creating accounts or bonus; explicit account is zero', () => {
      assert.equal(points.balance('u'), 0); assert.deepEqual(points.history('u'), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM point_accounts').get().n, 0);
      points.ensureAccount('u'); points.ensureAccount('u'); assert.equal(points.balance('u'), 0); assert.equal(ledgerCount(), 0);
    });
    await t.test('Credit/debit preserve balance-after and persisted ledger sum', () => {
      points.change(credit('credit', 100)); points.change({ ...credit('debit', -30), type: 'DEBIT' });
      assert.equal(points.balance('u'), 70); assert.deepEqual(points.history('u').map(x => x.balance_after), [70, 100]);
      assert.equal(db.prepare('SELECT sum(delta) AS n FROM point_transactions WHERE user_id=?').get('u').n, 70);
    });
    await t.test('Insufficient balance, invalid user/type/amount/sign/metadata rejected without writes', () => {
      for (const delta of [0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1), '10', null, 2n ** 63n]) assert.throws(() => points.change(credit('bad', delta)));
      for (const patch of [{ userId: 'missing' }, { type: 'UNKNOWN' }, { type: 'DEBIT' }, { reason: '' }, { policyVersion: '' }, { idempotencyKey: '' }, { delta: -1 }, { tournamentId: 'missing' }, { matchId: 'missing' }]) assert.throws(() => points.change({ ...credit('bad'), ...patch }));
      assert.throws(() => points.change({ ...credit('insufficient', -71), type: 'DEBIT' }));
      assert.equal(points.balance('u'), 70); assert.equal(ledgerCount(), 2);
    });
    await t.test('Same key retries return original transaction; mismatches reject', () => {
      const original = points.change(credit('credit', 100)); assert.equal(original.replayed, true); assert.equal(points.balance('u'), 70);
      for (const patch of [{ userId: 'v' }, { delta: 101 }, { type: 'SIGNUP_BONUS' }, { reason: 'Different' }, { policyVersion: 'v2' }]) assert.throws(() => points.change({ ...credit('credit', 100), ...patch }), { status: 409 });
      assert.equal(ledgerCount(), 2); assert.equal(points.history('v').length, 0);
    });
    await t.test('Safe integer maximum accepted; overflow and negative balances rejected by JS and SQL', () => {
      points.change(credit('max', Number.MAX_SAFE_INTEGER, 'v'));
      assert.equal(points.balance('v'), Number.MAX_SAFE_INTEGER);
      assert.throws(() => points.change(credit('overflow', 1, 'v')), { status: 409 });
      assert.throws(() => db.prepare('UPDATE point_accounts SET balance=? WHERE user_id=?').run(1.5, 'u'));
      assert.throws(() => db.prepare('UPDATE point_accounts SET balance=? WHERE user_id=?').run(-1, 'u'));
      assert.throws(() => db.prepare('UPDATE point_accounts SET balance=? WHERE user_id=?').run(9007199254740992n, 'u'));
    });
    await t.test('Ledger INSERT failure rolls back account update and account creation', () => {
      db.exec("CREATE TRIGGER fail_point_insert BEFORE INSERT ON point_transactions WHEN NEW.idempotency_key='fail' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
      assert.throws(() => points.change(credit('fail', 1))); assert.equal(points.balance('u'), 70); assert.equal(ledgerCount(), 3);
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('new', 'new', 'new', 'salt', 'hash', 1);
      assert.throws(() => points.change(credit('fail', 1, 'new')));
      assert.equal(db.prepare('SELECT count(*) AS n FROM point_accounts WHERE user_id=?').get('new').n, 0);
      db.exec('DROP TRIGGER fail_point_insert');
    });
    await t.test('Outer transaction composition rolls back all work; nested and async misuse rejected', () => {
      assert.throws(() => points.changeInTransaction(credit('outside')));
      assert.throws(() => immediateTransaction(db, () => { points.changeInTransaction(credit('outer')); db.prepare('UPDATE users SET display_name=? WHERE id=?').run('changed', 'u'); throw new Error('later failure'); }));
      assert.equal(points.balance('u'), 70); assert.equal(db.prepare('SELECT display_name FROM users WHERE id=?').get('u').display_name, 'u');
      assert.throws(() => immediateTransaction(db, () => points.change(credit('nested'))));
      assert.throws(() => immediateTransaction(db, () => Promise.resolve()));
    });
    await t.test('Repeated migration and restart preserve all existing rows and create no rewards', () => {
      const tables = ['users', 'sessions', 'auth_limits', 'tournaments', 'teams', 'brackets', 'tournament_owners', 'team_owners', 'point_accounts', 'point_transactions'];
      const snapshot = () => tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
      const before = snapshot(); migratePoints(db); migratePoints(db);
      const reopened = openStore(f.path); reopened.close(); assert.deepEqual(snapshot(), before);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => db.exec('DELETE FROM point_transactions')); assert.throws(() => db.exec("UPDATE point_transactions SET reason='changed'"));
    });
    await t.test('Related team/match IDs validated against actual tournament bracket', () => {
      db.prepare('INSERT INTO tournaments VALUES (?,?)').run('t', '{}'); db.prepare('INSERT INTO tournaments VALUES (?,?)').run('other', '{}');
      db.prepare('INSERT INTO teams VALUES (?,?,?)').run('team', 't', '{}');
      db.prepare('INSERT INTO brackets VALUES (?,?)').run('t', JSON.stringify({ rounds: [{ matches: [{ id: 'match' }] }] }));
      points.change({ ...credit('related'), tournamentId: 't', teamId: 'team', matchId: 'match' });
      assert.throws(() => points.change({ ...credit('wrong-team'), tournamentId: 'other', teamId: 'team' }));
      assert.throws(() => points.change({ ...credit('wrong-match'), tournamentId: 'other', matchId: 'match' }));
    });
  } finally { f.close(); }
});

test('Parallel workers/independent SQLite connections: exactly-once and ledger sum', async () => {
  const f = await fixture();
  try {
    const start = new SharedArrayBuffer(4);
    const code = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {DatabaseSync}=await import('node:sqlite');const {pointStorage}=await import(workerData.module);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');const p=pointStorage(db);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.start),0,0);for(const x of workerData.data)p.change(x);db.close();parentPort.postMessage('done');})().catch(e=>{throw e});`;
    const workers = Array.from({ length: 4 }, (_, i) => new Worker(code, { eval: true, workerData: { path: f.path, module: new URL('../points.js', import.meta.url).href, start, data: [credit('shared', 5), ...Array.from({ length: 10 }, (_, j) => credit(i + ':' + j, 1))] } }));
    await Promise.all(workers.map(w => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); })));
    const done = Promise.all(workers.map(w => new Promise((resolve, reject) => { w.once('exit', code => code === 0 ? resolve() : reject(new Error('Worker exit ' + code))); w.once('error', reject); })));
    Atomics.store(new Int32Array(start), 0, 1); Atomics.notify(new Int32Array(start), 0); await done;
    assert.equal(f.points.balance('u'), 45); assert.equal(f.db.prepare('SELECT count(*) AS n FROM point_transactions').get().n, 41);
    assert.equal(f.db.prepare('SELECT sum(delta) AS n FROM point_transactions').get().n, 45);
    assert.equal(f.points.history('u', { limit: 100 }).length, 41);
  } finally { f.close(); }
});

test('Signup, login and confirmed championship never create point rewards in STEP 3.1', async () => {
  const f = await fixture();
  try {
    const credentials = { username: 'isolated_signup', password: 'Isolated-test-password-123', displayName: 'Test' };
    await f.store.auth.register(credentials); const loggedIn = await f.store.auth.login(credentials); f.store.auth.newSession(loggedIn.id);
    const item = f.store.create({ name: 'No automatic reward', date: '2099-11-14', startsAt: '2099-11-14T01:00:00Z', recruitEndAt: '2099-11-14T00:00:00Z', capacity: 2, description: '' }, 'u');
    const teams = ['u', 'v'].map((userId, n) => f.store.register(item.id, { name: 'Team ' + n, representativeName: 'Test', members: Array.from({ length: 5 }, (_, i) => `Player${n}${i}#TEST`), representativeIndex: 0 }, userId));
    f.store.closeRegistration(item.id); const bracket = f.store.generateBracket(item.id), match = bracket.rounds[0].matches[0];
    for (const team of teams) f.store.submitResult(item.id, match.id, { teamId: team.id, winnerTeamId: match.slots[0].teamId, score: [1, 0] });
    assert.equal(f.store.list().find(x => x.id === item.id).bracket.championTeamId, match.slots[0].teamId);
    for (const table of ['point_accounts', 'point_transactions']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  } finally { f.close(); }
});

test('Migration DDL failure rolls back partial additions without altering legacy users', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('legacy'); CREATE TABLE point_transactions(id TEXT PRIMARY KEY);");
    assert.throws(() => migratePoints(db)); // The index cannot be built on an incompatible preexisting table.
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='point_accounts'").get().n, 0);
    assert.equal(db.prepare('SELECT id FROM users').get().id, 'legacy');
  } finally { db.close(); }
});
