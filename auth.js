import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
export function authStorage(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tournament_owners(tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id), user_id TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS team_owners(team_id TEXT PRIMARY KEY REFERENCES teams(id), tournament_id TEXT NOT NULL REFERENCES tournaments(id), user_id TEXT NOT NULL REFERENCES users(id), UNIQUE(tournament_id,user_id));`);
  let activeHashes = 0;
  async function hash(password, salt) {
    if (activeHashes >= 2) fail('인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    activeHashes++;
    try { return await derive(password, salt, 64, options); } finally { activeHashes--; }
  }
  const safeUser = row => row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
  return {
    owner: id => db.prepare('SELECT user_id FROM tournament_owners WHERE tournament_id=?').get(id)?.user_id,
    teamOwner: id => db.prepare('SELECT user_id FROM team_owners WHERE team_id=?').get(id)?.user_id,
    hasTeam: (id, userId) => Boolean(db.prepare('SELECT 1 FROM team_owners WHERE tournament_id=? AND user_id=?').get(id, userId)),
    linkTournament: (id, userId) => db.prepare('INSERT INTO tournament_owners VALUES (?, ?)').run(id, userId),
    linkTeam: (id, tournamentId, userId) => db.prepare('INSERT INTO team_owners VALUES (?, ?, ?)').run(id, tournamentId, userId),
    throttle(ip, username = '') {
      const now = Date.now(); db.prepare('DELETE FROM auth_limits WHERE reset_at < ?').run(now);
      for (const [key, limit] of [[digest(ip), 60], [digest(ip + ':' + String(username).toLowerCase()), 15]]) {
        const row = db.prepare('SELECT * FROM auth_limits WHERE key=?').get(key);
        if (row?.attempts >= limit) fail('인증 시도 횟수를 초과했습니다. 15분 후 다시 시도해 주세요.', 429);
        db.prepare('INSERT INTO auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key, now + 15 * 60000);
      }
    },
    async register(data) {
      if (!data || typeof data.username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(data.username)) fail('아이디는 영문·숫자·밑줄 3~32자입니다.', 400);
      if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128 || Buffer.byteLength(data.password) > 512) fail('비밀번호는 12~128자로 입력해 주세요.', 400);
      if (typeof data.displayName !== 'string' || !data.displayName.trim() || data.displayName.length > 40) fail('표시 이름은 1~40자입니다.', 400);
      const username = data.username.toLowerCase();
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail('이미 사용 중인 아이디입니다.', 409);
      const salt = randomBytes(16).toString('hex'), passwordHash = (await hash(data.password, salt)).toString('hex');
      const id = randomUUID();
      try { db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, username, data.displayName.trim(), salt, passwordHash, Date.now()); }
      catch (error) { if (error.errcode === 2067 || String(error.message).includes('UNIQUE constraint')) fail('이미 사용 중인 아이디입니다.', 409); throw error; }
      return { id, username, displayName: data.displayName.trim() };
    },
    async login(data) {
      if (!data || typeof data.username !== 'string' || typeof data.password !== 'string' || data.username.length > 32 || data.password.length > 128) fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
      const row = db.prepare('SELECT * FROM users WHERE username=?').get(data.username.toLowerCase());
      const computed = await hash(data.password, row?.salt ?? '00000000000000000000000000000000');
      if (!timingSafeEqual(computed, row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64)) || !row) fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
      return safeUser(row);
    },
    session(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token), Date.now());
      if (!row) return null;
      return { token, csrf: row.csrf, expiresAt: row.expires_at, user: row.user_id ? safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id)) : null };
    },
    newSession(userId = null, oldToken) {
      if (oldToken) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(oldToken));
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      if (db.prepare('SELECT count(*) AS count FROM sessions').get().count >= 10000) fail('활성 세션이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), expiresAt = Date.now() + 8 * 3600000;
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), userId, csrf, expiresAt);
      return { token, csrf, expiresAt };
    },
    logout: token => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)),
  };
}
