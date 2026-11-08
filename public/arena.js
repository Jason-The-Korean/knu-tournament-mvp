import { registrationReason } from './model.js';
export const competitionType = item => ['friendly', 'competitive'].includes(item.competitionType) ? item.competitionType : item.kind === 'friendly' ? 'friendly' : 'unknown';
export const participationScope = item => ['open', 'department'].includes(item.participationScope) ? item.participationScope : 'unknown';
export const typeLabel = item => ({ friendly: '친선', competitive: '경쟁', unknown: '유형 미설정' })[competitionType(item)];
export const scopeLabel = item => ({ open: '자유 참가', department: '학과 대항', unknown: '참가 범위 미설정' })[participationScope(item)];
export function tournamentStage(item) {
  if (item.bracket?.championTeamId) return { key: 'ended', label: '종료', reason: '결승 결과와 우승팀 확정' };
  const matches = item.bracket?.rounds.flatMap(round => round.matches) ?? [];
  if (matches.some(match => match.status !== 'bye' && (['AWAITING_CONFIRMATION', 'DISPUTED', 'CONFIRMED'].includes(match.resultStatus) || match.status === 'completed' || match.submissions?.length > 0))) return { key: 'live', label: '진행 중', reason: '실제 경기 결과 제출 또는 확정 기록 있음' };
  if (!item.permissions?.legacyReadOnly && !registrationReason(item)) return { key: 'accepting', label: '접수 중', reason: '모집 중이며 신청 가능한 정원과 권한 연결이 있음' };
  return { key: 'upcoming', label: '진행 예정', reason: '대진 확정·접수 마감 또는 읽기 전용 데모. 실제 경기 시작은 미확인' };
}
export function filterTournaments(items, filters, favorites = new Set()) {
  const query = (filters.query ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
  return items.filter(item => (filters.status === 'all' || tournamentStage(item).key === filters.status)
    && (filters.type === 'all' || competitionType(item) === filters.type)
    && (filters.scope === 'all' || participationScope(item) === filters.scope)
    && (!filters.favorites || favorites.has(item.id))
    && item.name.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(query));
}
