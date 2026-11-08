import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateTournament, validateTeam, registrationReason, normalizeKey, closeReason, canCancelUnderfilled, approvedTeamCount } from './public/model.js';
import { buildBracket } from './bracket.js';
import { applyResult } from './results.js';
import { validateScheduleRules } from './public/schedule-model.js';
import { proposeSchedule, consentSchedule } from './scheduling.js';
import { authStorage } from './auth.js';
import { immediateTransaction } from './transaction.js';
import { migratePoints, pointStorage } from './points.js';

export function openStore(filename, { now = () => Date.now() } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS brackets (tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id), payload TEXT NOT NULL);`);
  const auth = authStorage(db);
  migratePoints(db);
  const points = pointStorage(db, { now });
  function list() {
    return db.prepare('SELECT * FROM tournaments ORDER BY rowid').all().map(row => ({
      ...JSON.parse(row.payload), teams: db.prepare('SELECT payload FROM teams WHERE tournament_id=? ORDER BY rowid').all(row.id).map(team => JSON.parse(team.payload)),
      bracket: JSON.parse(db.prepare('SELECT payload FROM brackets WHERE tournament_id=?').get(row.id)?.payload ?? 'null'),
    }));
  }
  function transaction(action) {
    return immediateTransaction(db, action);
  }
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
  function insert(item) { db.prepare('INSERT INTO tournaments VALUES (?, ?)').run(item.id, JSON.stringify(item)); return { ...item, teams: [] }; }
  function find(id) { const item = list().find(item => item.id === id); if (!item) fail('대회를 찾을 수 없습니다.', 404); return item; }
  function saveTournament(item) { const { teams, bracket, ...payload } = item; db.prepare('UPDATE tournaments SET payload=? WHERE id=?').run(JSON.stringify(payload), item.id); }
  function saveBracket(item) { db.prepare('UPDATE brackets SET payload=? WHERE tournament_id=?').run(JSON.stringify(item.bracket), item.id); }
  return {
    list,
    auth,
    points,
    close: () => db.close(),
    create(data, userId) {
      const error = validateTournament(data, undefined, false, now()); if (error) fail(error);
      return transaction(() => { const item = insert({ id: randomUUID(), name: data.name.trim(), date: data.date, startsAt: new Date(data.startsAt).toISOString(), recruitEndAt: new Date(data.recruitEndAt).toISOString(), capacity: data.capacity, description: data.description.trim(), type: 'LoL · 5인 팀 · 싱글 엘리미네이션', kind: data.kind ?? 'standard', competitionType: data.competitionType ?? (data.kind === 'friendly' ? 'friendly' : null), participationScope: data.participationScope ?? null, earlyCloseMinTeams: data.earlyCloseMinTeams ?? null, finalFormat: data.finalFormat ?? 'Bo1', scheduling: data.scheduling ?? null, status: 'open', createdAt: new Date().toISOString() }); if (userId) auth.linkTournament(item.id, userId); return item; });
    },
    setScheduleRules(id, rules) {
      return transaction(() => {
        if (find(id).status === 'CANCELLED') fail('취소된 대회의 운영 규칙은 변경할 수 없습니다.', 409);
        const item = find(id); if (item.scheduling) fail('한 번 설정한 일정 규칙은 변경할 수 없습니다.', 409);
        const error = validateScheduleRules(rules, item.capacity); if (error) fail(error);
        if (item.startsAt && Date.parse(rules.startsAt) !== Date.parse(item.startsAt)) fail('일정 규칙의 시작 시각은 대회 시작 시각과 같아야 합니다.', 400);
        item.scheduling = rules; saveTournament(item); return item.scheduling;
      });
    },
    proposeSchedule(id, matchId, data) {
      return transaction(() => { const item = find(id); const proposal = proposeSchedule(item, matchId, data); saveBracket(item); return proposal; });
    },
    consentSchedule(id, matchId, proposalId, data, decline = false) {
      return transaction(() => { const item = find(id); const result = consentSchedule(item, matchId, proposalId, data, decline); saveBracket(item); return result; });
    },
    closeRegistration(id) {
      return transaction(() => {
        const item = find(id), instant = now(); const reason = closeReason(item, instant); if (reason) fail(reason, 409);
        if (canCancelUnderfilled(item, instant)) {
          item.status = 'CANCELLED';
          item.cancelReason = `최소 개최 조건 2팀 미달 (승인된 참가팀 ${approvedTeamCount(item)}팀)`;
          item.cancelledAt = new Date(instant).toISOString(); item.closedAt = item.cancelledAt;
          saveTournament(item); return item;
        }
        item.status = 'closed'; item.closedAt = new Date().toISOString(); saveTournament(item);
        return item;
      });
    },
    generateBracket(id) {
      return transaction(() => {
        const item = find(id);
        if (item.bracket) fail('이미 생성된 대진표는 재추첨하거나 덮어쓸 수 없습니다.', 409);
        if (item.status !== 'closed') fail('먼저 참가 모집을 마감해 주세요.', 409);
        if (item.capacity < 2 || item.capacity > 8 || item.teams.length < 2 || item.teams.length > 8 || item.teams.length > item.capacity) fail('정원 내 2~8팀이 참가해야 합니다.', 409);
        const bracket = buildBracket(item.teams, { finalFormat: item.finalFormat ?? 'Bo1' });
        db.prepare('INSERT INTO brackets VALUES (?, ?)').run(id, JSON.stringify(bracket));
        return bracket;
      });
    },
    submitResult(id, matchId, data) {
      return transaction(() => {
        const item = find(id);
        const bracket = applyResult(item, matchId, data);
        db.prepare('UPDATE brackets SET payload=? WHERE tournament_id=?').run(JSON.stringify(bracket), id);
        return bracket;
      });
    },
    importLegacy(items) {
      if (!Array.isArray(items) || items.length > 100) fail('가져올 대회 목록이 올바르지 않습니다.');
      return transaction(() => {
        for (const item of items) {
          if (!item || typeof item.id !== 'string' || !/^[\w-]{1,100}$/.test(item.id) || validateTournament(item, '0000-01-01', true)) fail('기존 대회 형식이 올바르지 않습니다. 원본은 보존됩니다.');
          const existing = db.prepare('SELECT payload FROM tournaments WHERE id=?').get(item.id);
          if (existing) {
            const old = JSON.parse(existing.payload);
            if (['name', 'date', 'capacity', 'description'].some(key => old[key] !== item[key])) fail('같은 ID의 다른 대회가 있어 가져오기를 중지했습니다.', 409);
          } else insert({ id: item.id, name: item.name, date: item.date, capacity: item.capacity, description: item.description, type: 'LoL · 5인 팀 · 싱글 엘리미네이션', status: 'open', legacy: true });
        }
        return list();
      });
    },
    register(id, data, userId) {
      return transaction(() => {
        const tournament = list().find(item => item.id === id);
        if (!tournament) fail('대회를 찾을 수 없습니다.', 404);
        const reason = registrationReason(tournament, now()); if (reason) fail(reason, 409);
        if (userId && auth.hasTeam(id, userId)) fail('한 계정은 같은 대회에서 한 팀만 대표할 수 있습니다.', 409);
        const error = validateTeam(data); if (error) fail(error);
        if (tournament.teams.some(team => normalizeKey(team.name) === normalizeKey(data.name))) fail('이미 등록된 팀 이름입니다.', 409);
        const used = new Set(tournament.teams.flatMap(team => team.members.map(normalizeKey)));
        if (data.members.some(member => used.has(normalizeKey(member)))) fail('이 대회에 이미 등록된 Riot ID가 있습니다.', 409);
        const team = { id: randomUUID(), name: data.name.trim(), representativeName: data.representativeName.trim(), members: data.members.map(member => member.normalize('NFKC').trim()), representativeIndex: data.representativeIndex, approvedAt: new Date().toISOString(), status: 'approved' };
        db.prepare('INSERT INTO teams VALUES (?, ?, ?)').run(team.id, id, JSON.stringify(team));
        if (userId) auth.linkTeam(team.id, id, userId);
        return team;
      });
    },
  };
}

