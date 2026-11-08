import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { timingSafeEqual } from 'node:crypto';
import { SIGNUP_BONUS } from './auth.js';

const assets = {
  '/points-ui.js': ['points-ui.js', 'text/javascript; charset=utf-8'],
  '/bracket-ui.js': ['bracket-ui.js', 'text/javascript; charset=utf-8'],
  '/detail-ui.js': ['detail-ui.js', 'text/javascript; charset=utf-8'],
  '/rules-ui.js': ['rules-ui.js', 'text/javascript; charset=utf-8'],
  '/assets/knu-arena-logo.png': ['assets/knu-arena-logo.png', 'image/png'],
  '/assets/knu-arena-logo-dark.png': ['assets/knu-arena-logo-dark.png', 'image/png'],
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/arena.js': ['arena.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/favorites.js': ['favorites.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/model.js': ['model.js', 'text/javascript; charset=utf-8'],
  '/schedule-model.js': ['schedule-model.js', 'text/javascript; charset=utf-8'],
  '/schedule-ui.js': ['schedule-ui.js', 'text/javascript; charset=utf-8'],
};
export function createServer({ dbPath = fileURLToPath(new URL('./data/tournament.sqlite', import.meta.url)), secureCookies = process.env.SESSION_COOKIE_SECURE === '1', now = () => Date.now() } = {}) {
  const store = openStore(dbPath, { now });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Invalid host'); }
    const path = new URL(req.url, 'http://localhost').pathname;
    if ((path === '/api/rules' || path === '/assets/rules/common-draft-v0.2.pdf') && ['GET', 'HEAD'].includes(req.method)) {
      let pdf = null;
      try { const bytes = await readFile(new URL('./public/assets/rules/common-draft-v0.2.pdf', import.meta.url)); if (bytes.subarray(0, 5).toString() === '%PDF-') pdf = bytes; } catch { /* Missing documents have no live link. */ }
      if (path === '/api/rules') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ available: Boolean(pdf), ...(pdf ? { title: 'LoL 대학생 토너먼트 임시 운영규정집', version: '0.2', draft: true, url: '/assets/rules/common-draft-v0.2.pdf' } : {}) }));
      }
      if (!pdf) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Rules PDF is not available'); }
      const download = new URL(req.url, 'http://localhost').searchParams.get('download') === '1';
      res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'; base-uri 'none'");
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="knu-arena-rules-draft-v0.2.pdf"`, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : pdf);
    }
    if (path.startsWith('/api/')) {
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      try {
        const cookieToken = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('knu_session='))?.slice(12);
        let session = store.auth.session(cookieToken);
        const setCookie = (token, age = 28800) => res.setHeader('Set-Cookie', `knu_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies || req.socket.encrypted ? '; Secure' : ''}`);
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`)) return json(403, { error: '다른 출처의 요청은 허용하지 않습니다.' });
        if (req.method === 'GET' && path === '/api/auth/session') {
          if (!session) { store.auth.throttle(req.socket.remoteAddress, 'session'); session = store.auth.newSession(); session.user = null; setCookie(session.token); }
          return json(200, { user: session.user, csrfToken: session.csrf });
        }
        if (req.method === 'GET' && ['/api/me/points', '/api/me/point-transactions'].includes(path)) {
          if (!session?.user) return json(401, { error: '내 포인트를 확인하려면 로그인이 필요합니다.' });
          const params = new URL(req.url, 'http://localhost').searchParams;
          const history = path === '/api/me/point-transactions';
          for (const key of params.keys()) if (!history || !['limit', 'offset'].includes(key) || params.getAll(key).length !== 1) return json(400, { error: '지원하지 않는 조회 조건입니다.' });
          if (!history) return json(200, { balance: store.points.balance(session.user.id) });
          const integer = (key, fallback, min, max) => {
            const raw = params.get(key); if (raw === null) return fallback;
            if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw Object.assign(new Error('거래내역 조회 범위가 올바르지 않습니다.'), { status: 400 });
            return Number(raw);
          };
          const limit = integer('limit', 20, 1, 50), offset = integer('offset', 0, 0, 1000000);
          const rows = store.points.history(session.user.id, { limit: limit + 1, offset });
          const tournaments = new Set(store.list().map(item => item.id));
          return json(200, { transactions: rows.slice(0, limit).map(row => ({ ...row, tournamentExists: Boolean(row.tournament_id && tournaments.has(row.tournament_id)) })), hasMore: rows.length > limit, nextOffset: offset + Math.min(rows.length, limit) });
        }
        if (req.method === 'GET' && path === '/api/tournaments') return json(200, store.list().map(item => {
          const owner = store.auth.owner(item.id); const userId = session?.user?.id;
          const manage = Boolean(owner && owner === userId);
          const teamIds = item.teams.filter(team => userId && store.auth.teamOwner(team.id) === userId).map(team => team.id);
          return { ...item, rewardPolicy: store.rewardPolicy(item.id), permissions: { manage, teamIds, legacyReadOnly: !owner }, teams: item.teams.map(team => manage || teamIds.includes(team.id) ? team : { id: team.id, name: team.name, status: team.status }) };
        }));
        if (req.method !== 'POST') return json(405, { error: '지원하지 않는 요청입니다.' });
        const credentials = ['/api/auth/register', '/api/auth/login'].includes(path);
        if (!credentials && !session?.user) return json(401, { error: '로그인이 필요합니다.' });
        const csrf = req.headers['x-csrf-token'];
        if (!session || typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf, 'hex'), Buffer.from(session.csrf, 'hex'))) return json(403, { error: 'CSRF 확인에 실패했습니다. 페이지를 새로고침해 주세요.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON 요청이 필요합니다.' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 100000) return json(413, { error: '요청이 너무 큽니다.' }); chunks.push(chunk); }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: '올바른 JSON이 아닙니다.' }); }
        if (credentials) {
          store.auth.throttle(req.socket.remoteAddress, data?.username);
          if (path === '/api/auth/register') return json(201, { user: await store.auth.register(data), signupBonus: SIGNUP_BONUS });
          const user = await store.auth.login(data); const rotated = store.auth.newSession(user.id, session.token); setCookie(rotated.token);
          return json(200, { user, csrfToken: rotated.csrf });
        }
        if (path === '/api/auth/logout') { store.auth.logout(session.token); setCookie('', 0); return json(200, { ok: true }); }
        if (path === '/api/tournaments') return json(201, store.create(data, session.user.id));
        if (path === '/api/import') return json(410, { error: '자동 가져오기는 종료되었습니다. 기존 데모는 읽기 전용이며 소유자를 자동 연결하지 않습니다.' });
        const target = path.match(/^\/api\/tournaments\/([\w-]+)/);
        const item = target && store.list().find(item => item.id === target[1]);
        if (!item) return json(404, { error: '대회를 찾을 수 없습니다.' });
        const owner = store.auth.owner(item.id), userId = session.user.id;
        if (!owner) return json(403, { error: '소유자 미연결 기존 데모는 읽기 전용입니다. 새 계정으로 대회를 만들어 주세요.' });
        const requireOwner = () => { if (owner !== userId) throw Object.assign(new Error('이 대회의 개최자만 실행할 수 있습니다.'), { status: 403 }); };
        const requireTeam = teamId => { if (!teamId || !item.teams.some(team => team.id === teamId) || store.auth.teamOwner(teamId) !== userId) throw Object.assign(new Error('로그인한 계정이 대표하는 팀으로만 제출·동의할 수 있습니다.'), { status: 403 }); };
        const rules = path.match(/^\/api\/tournaments\/([\w-]+)\/schedule-rules$/);
        if (rules) { requireOwner(); return json(200, store.setScheduleRules(rules[1], data)); }
        const proposal = path.match(/^\/api\/tournaments\/([\w-]+)\/matches\/([\w-]+)\/schedule-proposals$/);
        if (proposal) {
          if (data?.proposer?.role === 'organizer') { requireOwner(); data.proposer = { role: 'organizer', name: session.user.displayName }; }
          else requireTeam(data?.proposer?.teamId);
          return json(201, store.proposeSchedule(proposal[1], proposal[2], data));
        }
        const consent = path.match(/^\/api\/tournaments\/([\w-]+)\/matches\/([\w-]+)\/schedule-proposals\/([\w-]+)\/(consent|decline)$/);
        if (consent) { requireTeam(data?.teamId); const result = store.consentSchedule(consent[1], consent[2], consent[3], data, consent[4] === 'decline'); return json(result.error ? 409 : 200, result); }
        const result = path.match(/^\/api\/tournaments\/([\w-]+)\/matches\/([\w-]+)\/results$/);
        if (result) { requireTeam(data?.teamId); return json(200, store.submitResult(result[1], result[2], data)); }
        const action = path.match(/^\/api\/tournaments\/([\w-]+)\/(close|bracket)$/);
        if (action) {
          requireOwner();
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) return json(400, { error: '모집 마감과 대진표 생성은 빈 JSON 객체만 허용합니다. 대진 위치를 지정할 수 없습니다.' });
          return action[2] === 'close' ? json(200, store.closeRegistration(action[1])) : json(201, store.generateBracket(action[1]));
        }
        const match = path.match(/^\/api\/tournaments\/([\w-]+)\/teams$/);
        if (match) return json(201, store.register(match[1], data, userId));
        return json(404, { error: '요청 경로가 없습니다.' });
      } catch (error) { if (!error.status) console.error(error); return json(error.status || 500, { error: error.status ? error.message : '서버 저장에 실패했습니다. 다시 시도해 주세요.' }); }
    }
    const asset = assets[path];
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    if (path === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
    if (!asset) { res.writeHead(404); return res.end('Not found'); }
    try {
      const body = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500); res.end('Unable to load asset'); }
  });
  server.on('close', () => store.close());
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.on('error', error => { console.error(`서버 실행 실패: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`KNU ARENA: http://127.0.0.1:${port}`));
}
