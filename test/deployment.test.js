import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { sessionClient } from '../test-support/session-client.js';
import http from 'node:http';

// Node fetch replaces Host; use the HTTP client to exercise a reverse proxy's Host.
function proxyFetch(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])), json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTPS proxy host, secure sessions and fresh DB survive server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knu-deploy-'));
  const dbPath = join(directory, 'fresh.sqlite');
  let server;
  async function start() {
    server = createServer({ dbPath, secureCookies: true, allowedHosts: ['arena.example.test'] });
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await new Promise(resolve => server.close(resolve)); }
  try {
    let base = await start();
    const headers = { Host: 'arena.example.test', Origin: 'https://arena.example.test' };
    assert.equal((await proxyFetch(base, { headers })).status, 200);
    assert.equal((await proxyFetch(base + '/healthz', { headers })).status, 200);
    assert.equal((await proxyFetch(base, { headers: { Host: 'attacker.invalid' } })).status, 403);
    assert.deepEqual(await (await proxyFetch(base + '/api/tournaments', { headers })).json(), []);
    const client = sessionClient(base);
    // Test client uses localhost; public HTTPS Origin is tested separately below.
    const session = await client.request('/api/auth/session');
    assert.match(session.headers.get('set-cookie'), /; Secure/);
    assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await client.request('/api/auth/register', client.credentials)).status, 201);
    assert.equal((await client.request('/api/auth/login', client.credentials)).status, 200);
    const cookie = client.cookie;
    await stop();
    base = await start();
    const persisted = await (await proxyFetch(base + '/api/auth/session', { headers: { ...headers, Cookie: cookie } })).json();
    assert.equal(persisted.user.username, client.credentials.username);
    assert.equal((await proxyFetch(base + '/api/auth/session', { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
  } finally {
    if (server?.listening) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
