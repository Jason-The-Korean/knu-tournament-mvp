import { randomUUID } from 'node:crypto';
import { immediateTransaction, inImmediateTransaction } from './transaction.js';

const MAX = Number.MAX_SAFE_INTEGER;
const types = ['CREDIT', 'DEBIT', 'SIGNUP_BONUS', 'TOURNAMENT_WIN', 'PARTICIPATION_REWARD'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Additive, repeatable migration; never creates accounts or backfills rewards.
export function migratePoints(db) {
  return immediateTransaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS point_accounts (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
      balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(balance)='integer' AND balance BETWEEN 0 AND ${MAX}),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS point_transactions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES point_accounts(user_id),
      delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta!=0 AND delta BETWEEN -${MAX} AND ${MAX}),
      balance_after INTEGER NOT NULL CHECK(typeof(balance_after)='integer' AND balance_after BETWEEN 0 AND ${MAX}),
      type TEXT NOT NULL CHECK(type IN ('CREDIT','DEBIT','SIGNUP_BONUS','TOURNAMENT_WIN','PARTICIPATION_REWARD')),
      reason TEXT NOT NULL CHECK(length(trim(reason))>0),
      tournament_id TEXT REFERENCES tournaments(id),
      team_id TEXT REFERENCES teams(id),
      match_id TEXT,
      policy_version TEXT NOT NULL CHECK(length(trim(policy_version))>0),
      created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0),
      CHECK((type='DEBIT' AND delta<0) OR (type!='DEBIT' AND delta>0))
    );
    CREATE INDEX IF NOT EXISTS point_transactions_user ON point_transactions(user_id, created_at, id);
    CREATE TRIGGER IF NOT EXISTS point_transactions_no_update BEFORE UPDATE ON point_transactions
      BEGIN SELECT RAISE(ABORT, 'Point ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS point_transactions_no_delete BEFORE DELETE ON point_transactions
      BEGIN SELECT RAISE(ABORT, 'Point ledger is append-only'); END;
  `));
}

export function pointStorage(db, { now = () => Date.now() } = {}) {
  function user(userId) {
    if (!text(userId, 100) || !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail('포인트 대상 사용자를 찾을 수 없습니다.', 404);
  }
  function timestamp() {
    const instant = now(); if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime())) fail('포인트 처리 시각이 올바르지 않습니다.');
    return new Date(instant).toISOString();
  }
  function ensureInTransaction(userId) {
    if (!inImmediateTransaction(db)) throw new Error('Point writes require an outer SQLite transaction.');
    user(userId);
    db.prepare('INSERT INTO point_accounts(user_id,balance,updated_at) VALUES (?,0,?) ON CONFLICT(user_id) DO NOTHING').run(userId, timestamp());
  }
  function balance(userId) { user(userId); return db.prepare('SELECT balance FROM point_accounts WHERE user_id=?').get(userId)?.balance ?? 0; }
  function history(userId, { limit = 50, offset = 0 } = {}) {
    user(userId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('거래내역 조회 범위가 올바르지 않습니다.');
    return db.prepare('SELECT * FROM point_transactions WHERE user_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
  }
  // Internal use only. If this throws, the owner of the transaction MUST roll back.
  function changeInTransaction(data) {
    if (!inImmediateTransaction(db)) throw new Error('Point writes require an outer SQLite transaction.');
    if (!data || typeof data !== 'object') fail('포인트 거래 정보가 필요합니다.');
    const { userId, delta, type, reason, policyVersion, idempotencyKey } = data;
    user(userId);
    if (!Number.isSafeInteger(delta) || delta === 0) fail('포인트 증감량은 0이 아닌 안전한 정수여야 합니다.');
    if (!types.includes(type) || (type === 'DEBIT' ? delta >= 0 : delta <= 0)) fail('포인트 거래 유형 또는 증감 방향이 올바르지 않습니다.');
    if (!text(reason, 500) || !text(policyVersion, 100) || !text(idempotencyKey, 200)) fail('지급 사유·정책 버전·중복 방지 키가 필요합니다.');
    const tournamentId = data.tournamentId ?? null, teamId = data.teamId ?? null, matchId = data.matchId ?? null;
    for (const value of [tournamentId, teamId, matchId]) if (value !== null && !text(value, 100)) fail('관련 기록 ID가 올바르지 않습니다.');
    if (tournamentId && !db.prepare('SELECT 1 FROM tournaments WHERE id=?').get(tournamentId)) fail('관련 대회가 없습니다.');
    if (teamId) {
      const team = db.prepare('SELECT tournament_id FROM teams WHERE id=?').get(teamId);
      if (!team || (tournamentId && team.tournament_id !== tournamentId)) fail('관련 팀 또는 대회 연결이 올바르지 않습니다.');
    }
    if (matchId) {
      const bracket = tournamentId && db.prepare('SELECT payload FROM brackets WHERE tournament_id=?').get(tournamentId);
      if (!bracket || !JSON.parse(bracket.payload).rounds.some(round => round.matches.some(match => match.id === matchId))) fail('관련 경기를 찾을 수 없습니다.');
    }
    const previous = db.prepare('SELECT * FROM point_transactions WHERE idempotency_key=?').get(idempotencyKey);
    if (previous) {
      if (previous.user_id !== userId || previous.delta !== delta || previous.type !== type || previous.reason !== reason || previous.policy_version !== policyVersion || previous.tournament_id !== tournamentId || previous.team_id !== teamId || previous.match_id !== matchId) fail('동일 중복 방지 키에 다른 거래 내용이 있습니다.', 409);
      return { transaction: previous, replayed: true };
    }
    const next = balance(userId) + delta;
    if (!Number.isSafeInteger(next) || next < 0) fail('잔액이 부족하거나 안전한 정수 범위를 초과합니다.', 409);
    ensureInTransaction(userId);
    const at = timestamp(), id = randomUUID();
    db.prepare('UPDATE point_accounts SET balance=?,updated_at=? WHERE user_id=?').run(next, at, userId);
    db.prepare(`INSERT INTO point_transactions(id,user_id,delta,balance_after,type,reason,tournament_id,team_id,match_id,policy_version,created_at,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, delta, next, type, reason, tournamentId, teamId, matchId, policyVersion, at, idempotencyKey);
    return { transaction: db.prepare('SELECT * FROM point_transactions WHERE id=?').get(id), replayed: false };
  }
  return {
    balance, history,
    ensureAccount: userId => immediateTransaction(db, () => ensureInTransaction(userId)),
    change: data => immediateTransaction(db, () => changeInTransaction(data)),
    changeInTransaction,
  };
}
