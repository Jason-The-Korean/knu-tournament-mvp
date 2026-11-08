import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { sessionClient } from '../test-support/session-client.js';
import { pointStorage } from '../points.js';

test('Signup bonus: real protected API, atomic account creation and no retroactive rewards', async t => {
  const path = join(await mkdtemp(join(tmpdir(), 'knu-signup-bonus-')), 'test.sqlite');
  const server = createServer({ dbPath: path }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, client = sessionClient(base), db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON'); const points = pointStorage(db);
  const counts = () => ['users','point_accounts','point_transactions'].map(n => db.prepare(`SELECT count(*) AS n FROM ${n}`).get().n);
  let userId;
  try {
    await t.test('Successful registration ignores client reward fields and grants exactly 100P once', async () => {
      await client.bootstrap();
      const r = await client.request('/api/auth/register', { ...client.credentials, amount: 999999, userId: 'victim', signupBonus: { amount: 999999 } });
      assert.equal(r.status, 201); userId = r.body.user.id; assert.equal(r.body.signupBonus.amount, 100);
      assert.equal(points.balance(userId), 100); const [tx] = points.history(userId);
      assert.equal(tx.type, 'SIGNUP_BONUS'); assert.equal(tx.delta, 100); assert.equal(tx.balance_after, 100); assert.equal(tx.policy_version, 'demo-v0.1'); assert.equal(tx.idempotency_key, `signup:${userId}`);
      assert.deepEqual(counts(), [1, 1, 1]);
    });
    await t.test('Duplicate username creates no user/account/transaction; retries cannot award twice', async () => {
      assert.equal((await client.request('/api/auth/register', client.credentials)).status, 409); assert.deepEqual(counts(), [1, 1, 1]);
      const [tx] = points.history(userId);
      assert.equal(points.change({ userId, delta: 100, type: tx.type, reason: tx.reason, policyVersion: tx.policy_version, idempotencyKey: tx.idempotency_key }).replayed, true);
      assert.throws(() => points.change({ userId, delta: 101, type: tx.type, reason: tx.reason, policyVersion: tx.policy_version, idempotencyKey: tx.idempotency_key }), { status: 409 });
      assert.equal(points.balance(userId), 100); assert.deepEqual(counts(), [1, 1, 1]);
    });
    await t.test('Ledger failure rolls back user creation, account creation and balance; error is not duplicate username', async () => {
      db.exec("CREATE TRIGGER fail_signup BEFORE INSERT ON point_transactions BEGIN SELECT RAISE(ABORT,'UNIQUE constraint failed: point_transactions.idempotency_key'); END;");
      const other = sessionClient(base); await other.bootstrap();
      const r = await other.request('/api/auth/register', other.credentials); assert.equal(r.status, 500); assert.ok(!r.body.error.includes('아이디')); assert.deepEqual(counts(), [1, 1, 1]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE username=?').get(other.credentials.username).n, 0);
      db.exec('DROP TRIGGER fail_signup');
      assert.equal((await other.request('/api/auth/register', other.credentials)).status, 201); assert.deepEqual(counts(), [2, 2, 2]);
    });
    await t.test('Login, session refresh, logout and relogin do not pay again', async () => {
      assert.equal((await client.login()).status, 200); await client.bootstrap(); await client.bootstrap();
      assert.equal((await client.request('/api/auth/logout', {})).status, 200); await client.bootstrap(); assert.equal((await client.login()).status, 200);
      assert.equal(points.balance(userId), 100); assert.equal(points.history(userId).length, 1);
    });
    await t.test('Preexisting member without account stays zero through login and reads', async () => {
      const legacy = sessionClient(base); assert.equal((await legacy.signup()).status, 201);
      // Represent a pre-feature member in this isolated DB only, without rewriting any ledger.
      const { scryptSync } = await import('node:crypto'); const salt = 'isolated-legacy-salt';
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('legacy', 'legacy_user', 'Legacy', salt, scryptSync(legacy.credentials.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64*1024*1024 }).toString('hex'), 1);
      const c = sessionClient(base); await c.bootstrap(); assert.equal((await c.request('/api/auth/login', { username: 'legacy_user', password: legacy.credentials.password })).status, 200);
      assert.equal(points.balance('legacy'), 0); assert.deepEqual(points.history('legacy'), []); assert.equal(db.prepare('SELECT count(*) AS n FROM point_accounts WHERE user_id=?').get('legacy').n, 0);
    });
    await t.test('Parallel duplicate username registration commits only one signup reward', async () => {
      const a = sessionClient(base), b = sessionClient(base); await a.bootstrap(); await b.bootstrap(); const before = counts();
      const responses = await Promise.all([a.request('/api/auth/register', a.credentials), b.request('/api/auth/register', a.credentials)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]); assert.deepEqual(counts(), before.map(n => n + 1));
    });
  } finally { db.close(); await new Promise(r => server.close(r)); }
});
