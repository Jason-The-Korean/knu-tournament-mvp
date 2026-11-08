import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { STORAGE_KEY, validateTournament, readTournaments } from '../public/model.js';

const valid = { name: '경북대 LoL 대회', date: '2026-11-14', startsAt: '2026-11-14T00:00:00Z', recruitEndAt: '2026-11-13T00:00:00Z', capacity: 8, description: '' };
test('대회 입력 검증: 정상 입력, 빈 이름, 과거 날짜, 잘못된 팀 수', () => {
  assert.equal(validateTournament(valid, '2026-11-07'), '');
  for (const change of [{ name: '' }, { date: '2026-11-06' }, { capacity: 9 }]) {
    assert.notEqual(validateTournament({ ...valid, ...change }, '2026-11-07'), '');
  }
});
test('브라우저 저장 형식 재읽기 및 손상 데이터 감지', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null };
  assert.deepEqual(readTournaments(storage), []);
  const items = [{ ...valid, id: 'sample' }];
  data.set(STORAGE_KEY, JSON.stringify(items));
  assert.deepEqual(readTournaments(storage), items);
  data.set(STORAGE_KEY, 'broken');
  assert.throws(() => readTournaments(storage));
  data.set(STORAGE_KEY, '{}');
  assert.throws(() => readTournaments(storage));
});
test('실제 HTTP 서버: 모든 자산, 404, 경로 접근, 지원하지 않는 메서드', async () => {
  const server = createServer({ dbPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/app.js', '/styles.css', '/model.js']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await fetch(base + '/.git/config')).status, 404);
    assert.equal((await fetch(base + '/missing')).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
