const active = new WeakSet();
export const inImmediateTransaction = db => active.has(db);
// Synchronous SQLite work only. Callers inside this boundary must not BEGIN again.
export function immediateTransaction(db, action) {
  if (active.has(db)) throw new Error('Nested SQLite transactions are not supported.');
  db.exec('BEGIN IMMEDIATE');
  active.add(db);
  try {
    const result = action();
    if (result && typeof result.then === 'function') throw new Error('SQLite transaction callbacks must be synchronous.');
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { active.delete(db); }
}
