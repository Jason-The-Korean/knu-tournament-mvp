import test from 'node:test';
import assert from 'node:assert/strict';
import { competitionType, participationScope, tournamentStage, filterTournaments } from '../public/arena.js';
import { openStore } from '../store.js';
import { FAVORITES_KEY, loadFavorites, saveFavorites } from '../public/favorites.js';

const event = extra => ({ id: 'sample', name: 'KNU LoL 대회', date: '2099-11-14', capacity: 4, status: 'open', teams: [], permissions: { legacyReadOnly: false }, ...extra });
test('기존 standard와 누락 범위는 추정하지 않음, 명시된 유형/범위만 분류', () => {
  assert.equal(competitionType(event({ kind: 'standard' })), 'unknown');
  assert.equal(competitionType(event({ kind: 'friendly' })), 'friendly');
  assert.equal(competitionType(event({ competitionType: 'competitive' })), 'competitive');
  assert.equal(participationScope(event({})), 'unknown');
  assert.equal(participationScope(event({ participationScope: 'department' })), 'department');
});
test('관심 대회 로컬 저장·해제·손상 데이터 보존 및 저장 실패', () => {
  const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  assert.equal(loadFavorites(storage).size, 0);
  saveFavorites(storage, new Set(['a', 'b'])); assert.deepEqual([...loadFavorites(storage)], ['a', 'b']);
  saveFavorites(storage, new Set(['b'])); assert.deepEqual([...loadFavorites(storage)], ['b']);
  map.set(FAVORITES_KEY, 'broken'); assert.throws(() => loadFavorites(storage)); assert.equal(map.get(FAVORITES_KEY), 'broken');
  assert.throws(() => saveFavorites({ setItem: () => { throw new Error('quota'); } }, new Set(['a'])), /quota/);
});
test('접수·예정·진행·종료는 실제 기록 기준, 날짜 경과·BYE만으로 진행/종료 추정 금지', () => {
  assert.equal(tournamentStage(event({})).key, 'accepting');
  assert.equal(tournamentStage(event({ date: '2020-01-01' })).key, 'upcoming');
  assert.equal(tournamentStage(event({ permissions: { legacyReadOnly: true } })).key, 'upcoming');
  const bracket = { rounds: [{ matches: [{ status: 'bye', winnerTeamId: 'team' }] }] };
  assert.equal(tournamentStage(event({ bracket })).key, 'upcoming');
  bracket.rounds[0].matches.push({ status: 'waiting', resultStatus: 'AWAITING_CONFIRMATION' });
  assert.equal(tournamentStage(event({ bracket })).key, 'live');
  bracket.championTeamId = 'team'; assert.equal(tournamentStage(event({ bracket })).key, 'ended');
});
test('검색·상태·유형·범위·관심은 AND 결합, 이름만 검색', () => {
  const items = [event({ id: 'a', competitionType: 'friendly', participationScope: 'open' }), event({ id: 'b', competitionType: 'competitive', participationScope: 'department' }), event({ id: 'c', description: '다른 검색어' })];
  const filters = { status: 'accepting', type: 'competitive', scope: 'department', query: '  ｋｎｕ lol  ', favorites: true };
  assert.deepEqual(filterTournaments(items, filters, new Set(['b'])).map(t => t.id), ['b']);
  assert.equal(filterTournaments(items, { ...filters, type: 'friendly' }, new Set(['b'])).length, 0);
  assert.equal(filterTournaments(items, { status: 'all', type: 'all', scope: 'all', query: '다른 검색어', favorites: false }).length, 0);
});
test('새 대회 유형/참가 범위 저장·검증, 기존 행 자동 갱신 없음', () => {
  const store = openStore(':memory:');
  try {
    const base = { name: '분류', date: '2099-11-14', capacity: 2, description: '' };
    const old = store.create(base), before = structuredClone(store.list()[0]);
    const item = store.create({ ...base, kind: 'standard', competitionType: 'competitive', participationScope: 'department' });
    assert.equal(item.competitionType, 'competitive'); assert.equal(item.participationScope, 'department');
    assert.throws(() => store.create({ ...base, competitionType: 'ranked' }), /유형/);
    assert.throws(() => store.create({ ...base, kind: 'friendly', competitionType: 'competitive' }), /일치/);
    assert.throws(() => store.create({ ...base, participationScope: 'external' }), /범위/);
    assert.deepEqual(store.list().find(t => t.id === old.id), before);
  } finally { store.close(); }
});
