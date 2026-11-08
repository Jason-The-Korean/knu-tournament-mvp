export const STORAGE_KEY = 'knu-tournaments-v1';
import { validateScheduleRules, isInstant } from './schedule-model.js';
export const kstDate = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
export function kstInputToIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !isInstant(value + ':00+09:00')) throw new Error('한국 시간(KST)의 올바른 날짜와 시간을 입력해 주세요.');
  return new Date(value + ':00+09:00').toISOString();
}
export const deadlinePassed = (item, now = Date.now()) => item.recruitEndAt != null && Number.isFinite(Date.parse(item.recruitEndAt)) && now >= Date.parse(item.recruitEndAt);
export const displayKst = value => isInstant(value) ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' (KST)' : '미설정';
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validateTournament(data, minDate, legacy = false, now = Date.now()) {
  minDate ??= kstDate(now);
  if (!data || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60) return '대회명은 1~60자로 입력해 주세요.';
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(data.date)) || new Date(data.date).toISOString().slice(0, 10) !== data.date || data.date < minDate) return '오늘 이후의 대회 날짜를 선택해 주세요.';
  if (!(legacy ? [4, 8, 16, 32] : [2, 3, 4, 5, 6, 7, 8]).includes(data.capacity)) return '참가 팀 수는 2~8팀이어야 합니다.';
  if (typeof data.description !== 'string' || data.description.length > 300) return '소개는 300자 이하로 입력해 주세요.';
  if (data.kind !== undefined && !['standard', 'friendly'].includes(data.kind)) return '대회 구분이 올바르지 않습니다.';
  if (data.competitionType != null && !['friendly', 'competitive'].includes(data.competitionType)) return '유형은 친선 또는 경쟁이어야 합니다.';
  if (data.competitionType != null && ((data.competitionType === 'friendly') !== (data.kind === 'friendly'))) return '대회 유형과 운영 구분이 일치해야 합니다.';
  if (data.participationScope != null && !['open', 'department'].includes(data.participationScope)) return '참가 범위는 자유 참가 또는 학과 대항이어야 합니다.';
  if (data.scheduling != null) { const error = validateScheduleRules(data.scheduling, data.capacity); if (error) return error; }
  if (data.finalFormat !== undefined && !['Bo1', 'Bo3'].includes(data.finalFormat)) return '결승은 Bo1 또는 Bo3만 지원합니다.';
  if (data.earlyCloseMinTeams != null && (data.kind !== 'friendly' || !Number.isInteger(data.earlyCloseMinTeams) || data.earlyCloseMinTeams < 2 || data.earlyCloseMinTeams > data.capacity)) return '조기 마감은 친선 대회에서 2팀 이상, 정원 이하로 사전 공지해야 합니다.';
  if (!legacy) {
    if (!isInstant(data.recruitEndAt)) return '모집 마감 일시는 필수이며 시간대를 포함해야 합니다.';
    if (!isInstant(data.startsAt)) return '대회 시작 시각은 필수이며 시간대를 포함해야 합니다.';
    if (Date.parse(data.recruitEndAt) <= now) return '모집 마감 일시는 현재 시각보다 미래여야 합니다.';
    if (Date.parse(data.recruitEndAt) > Date.parse(data.startsAt)) return '모집 마감 일시는 대회 시작 시각보다 늦을 수 없습니다.';
    if (kstDate(Date.parse(data.startsAt)) !== data.date) return '대회 날짜와 한국 시간(KST) 기준 시작 시각의 날짜가 일치해야 합니다.';
    if (data.scheduling && Date.parse(data.scheduling.startsAt) !== Date.parse(data.startsAt)) return '일정 규칙의 시작 시각은 대회 시작 시각과 같아야 합니다.';
  }
  return '';
}
export const normalizeKey = value => value.normalize('NFKC').trim().toLowerCase();
export const resultState = match => match.status === 'bye' ? 'BYE' : (match.resultStatus ?? 'PENDING');
export function matchFormat(tournament, match) {
  return match.round === tournament.bracket.rounds.length ? (tournament.bracket.finalFormat ?? tournament.finalFormat ?? 'Bo1') : 'Bo1';
}
// Display stored settings only. Keep matchFormat's existing processing fallback unchanged.
export function finalFormatLabel(tournament) {
  const format = tournament.bracket?.finalFormat ?? tournament.finalFormat;
  return ['Bo1', 'Bo3'].includes(format) ? format : '경기 방식 미설정';
}
export function matchFormatLabel(tournament, match) {
  return match.round === tournament.bracket.rounds.length ? finalFormatLabel(tournament) : 'Bo1';
}
export function validateResult(match, data, format) {
  if (!data || typeof data !== 'object' || !match.slots.some(slot => slot.teamId === data.teamId)) return '이 경기 참가팀만 결과를 제출할 수 있습니다.';
  if (!match.slots.some(slot => slot.teamId === data.winnerTeamId)) return '승리 팀은 이 경기 참가팀 중에서 선택해야 합니다.';
  if (!Array.isArray(data.score) || data.score.length !== 2 || data.score.some(value => !Number.isInteger(value) || value < 0)) return '점수는 슬롯 순서대로 정수 2개를 입력해야 합니다.';
  const winnerIndex = match.slots.findIndex(slot => slot.teamId === data.winnerTeamId);
  const required = format === 'Bo3' ? 2 : 1;
  if (data.score[winnerIndex] !== required || data.score[1 - winnerIndex] >= required) return format === 'Bo3' ? 'Bo3 점수는 2:0, 2:1, 0:2, 1:2만 가능합니다.' : 'Bo1 점수는 1:0 또는 0:1이어야 합니다.';
  return '';
}
export function validateTeam(data) {
  if (!data || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 40) return '팀 이름은 1~40자로 입력해 주세요.';
  if (typeof data.representativeName !== 'string' || !data.representativeName.trim() || data.representativeName.length > 40) return '대표자 이름은 1~40자로 입력해 주세요.';
  if (!Array.isArray(data.members) || data.members.length !== 5) return '팀원은 정확히 5명이어야 합니다.';
  if (data.members.some(member => typeof member !== 'string' || !/^[^#\s][^#\r\n]{0,38}#[\p{L}\p{N}]{2,10}$/u.test(member.normalize('NFKC').trim()))) return '팀원 5명 모두 게임이름#태그 형식의 Riot ID를 입력해 주세요. 태그는 문자·숫자 2~10자입니다. (소유권 미검증)';
  if (new Set(data.members.map(normalizeKey)).size !== 5) return '같은 팀에 중복된 Riot ID가 있습니다.';
  if (!Number.isInteger(data.representativeIndex) || data.representativeIndex < 0 || data.representativeIndex > 4) return '대표자인 팀원을 선택해 주세요.';
  return '';
}
export function registrationReason(tournament, now = Date.now()) {
  if (tournament.bracket) return '대진표가 확정되어 참가 신청이 종료되었습니다.';
  if (deadlinePassed(tournament, now)) return '모집 마감 일시가 지나 참가 신청할 수 없습니다.';
  if (tournament.capacity < 2 || tournament.capacity > 8) return '기존 대회는 보존되었습니다. 참가 신청은 정원 2~8팀 대회에서 지원합니다.';
  if (tournament.status !== 'open' || tournament.date < today()) return '모집이 종료된 대회입니다.';
  if (tournament.teams.length >= tournament.capacity) return '정원이 가득 찼습니다.';
  return '';
}
export function closingPolicy(tournament) {
  if (tournament.recruitEndAt) return `모집 마감 ${displayKst(tournament.recruitEndAt)} · 정원 충족 또는 마감 시각 경과 시 최소 2팀으로 수동 마감 가능.${tournament.kind === 'friendly' && Number.isInteger(tournament.earlyCloseMinTeams) ? ` 사전 공지: ${tournament.earlyCloseMinTeams}팀 이상 친선 조기 마감 가능.` : ''}`;
  return tournament.kind === 'friendly' && Number.isInteger(tournament.earlyCloseMinTeams)
    ? `사전 공지: ${tournament.earlyCloseMinTeams}팀 이상 참가 시 조기 마감 가능 (마감 시 참가 취소 없이 현재 팀으로 진행)`
    : '모집 규칙: 정원이 찼거나 대회 날짜가 지난 뒤 마감 가능. 조기 마감은 허용되지 않습니다.';
}
export function closeReason(tournament, now = Date.now()) {
  if (tournament.bracket) return '이미 대진표가 생성되었습니다.';
  if (tournament.status !== 'open') return '이미 모집이 마감되었습니다.';
  if (tournament.capacity < 2 || tournament.capacity > 8 || tournament.teams.length > 8) return '마감과 대진표 생성은 정원 2~8팀 대회에서 지원합니다.';
  if (tournament.teams.length < 2) return '최소 2팀이 참가해야 모집을 마감할 수 있습니다.';
  if (deadlinePassed(tournament, now)) return '';
  if (tournament.teams.length >= tournament.capacity || tournament.date < today()) return '';
  if (tournament.kind === 'friendly' && Number.isInteger(tournament.earlyCloseMinTeams) && tournament.earlyCloseMinTeams >= 2 && tournament.earlyCloseMinTeams <= tournament.capacity && tournament.teams.length >= tournament.earlyCloseMinTeams) return '';
  return '정원 미달입니다. 사전 공지된 친선 대회 조기 마감 조건을 만족하거나 모집 기간이 종료되어야 합니다.';
}
export function readTournaments(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.date !== 'string' || typeof item.description !== 'string' || ![4, 8, 16, 32].includes(item.capacity))) throw new Error('Invalid saved data');
  return items;
}
