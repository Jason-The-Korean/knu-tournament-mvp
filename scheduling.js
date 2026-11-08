import { randomUUID } from 'node:crypto';
import { resultState, matchFormat } from './public/model.js';
import { isInstant, roundSize, durationMinutes } from './public/schedule-model.js';

function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function allMatches(item) { return item.bracket?.rounds.flatMap(round => round.matches) ?? []; }
function find(item, id) { const match = allMatches(item).find(match => match.id === id); if (!match) fail('경기를 찾을 수 없습니다.', 404); if (resultState(match) === 'BYE') fail('BYE는 일정 합의 대상이 아닙니다.'); return match; }
const overlap = (a, b, c, d) => a < d && c < b;
export function scheduleConflict(item, match, startsAt) {
  const rules = item.scheduling;
  if (!rules) return '대회 일정 규칙을 먼저 설정해 주세요.';
  if (match.slots.some(slot => !slot.teamId)) return '양쪽 참가팀이 확정되어야 공식 일정을 정할 수 있습니다.';
  const start = Date.parse(startsAt), end = start + durationMinutes(matchFormat(item, match)) * 60000;
  if (start < Date.parse(rules.startsAt) || end > Date.parse(rules.endsAt)) return '예상 경기 종료까지 대회 시작·종료 범위 안에 있어야 합니다.';
  const window = rules.rounds[roundSize(item, match)];
  if (!window || start < Date.parse(window.startsAt) || end > Date.parse(window.endsAt)) return '예상 경기 종료까지 해당 라운드 시작·종료 범위 안에 있어야 합니다.';
  const matches = allMatches(item), others = matches.filter(other => other.id !== match.id && other.schedule);
  for (const slot of match.slots) {
    const previous = matches.find(other => other.id === slot.sourceMatchId);
    if (previous && resultState(previous) !== 'BYE' && (!previous.schedule || Date.parse(previous.schedule.endsAt) > start)) return `선행 경기 ${previous.displayId}의 공식 일정이 없거나 예상 종료보다 시작이 빠릅니다.`;
  }
  const next = matches.find(other => other.id === match.nextMatchId);
  if (next?.schedule && end > Date.parse(next.schedule.startsAt)) return `후속 경기 ${next.displayId} 시작 전에 끝나야 합니다.`;
  const teams = match.slots.map(slot => slot.teamId);
  for (const other of others) if (other.slots.some(slot => teams.includes(slot.teamId)) && overlap(start, end, Date.parse(other.schedule.startsAt), Date.parse(other.schedule.endsAt))) return `같은 참가팀의 확정 경기 ${other.displayId}와 시간이 겹칩니다.`;
  const events = [[start, 1], [end, -1]];
  for (const other of others) {
    const left = Math.max(start, Date.parse(other.schedule.startsAt)), right = Math.min(end, Date.parse(other.schedule.endsAt));
    if (left < right) events.push([left, 1], [right, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0;
  for (const [, delta] of events) { count += delta; if (count > rules.maxConcurrent) return `최대 동시 경기 수 ${rules.maxConcurrent}경기를 초과합니다.`; }
  return '';
}
export function proposeSchedule(item, matchId, data) {
  const match = find(item, matchId);
  if (!item.scheduling) fail('대회 일정 규칙을 먼저 설정해 주세요.');
  if (!data || !isInstant(data.startsAt)) fail('시간대를 포함한 올바른 후보 시작 일시가 필요합니다.', 400);
  const proposer = data.proposer;
  if (!proposer || !['team', 'organizer'].includes(proposer.role)) fail('제안자 구분이 필요합니다.', 400);
  if (proposer.role === 'team' && (!proposer.teamId || !match.slots.some(slot => slot.teamId === proposer.teamId))) fail('해당 경기 참가팀만 팀 자격으로 제안할 수 있습니다.', 400);
  if (proposer.role === 'organizer' && (typeof proposer.name !== 'string' || !proposer.name.trim() || proposer.name.length > 40)) fail('데모 운영진 이름을 1~40자로 입력해 주세요.', 400);
  if (match.schedule && (match.scheduleChangeCount ?? 0) >= 1) fail('일반 일정 변경은 1회까지만 가능합니다.');
  const startsAt = new Date(data.startsAt).toISOString();
  if (match.schedule?.startsAt === startsAt) fail('이미 확정된 시각과 같은 제안입니다.');
  match.scheduleProposals ??= [];
  const revision = match.schedule?.revision ?? 0;
  if (match.scheduleProposals.some(proposal => proposal.baseRevision === revision && proposal.startsAt === startsAt && proposal.status === 'PENDING')) fail('같은 후보 일시의 제안이 이미 있습니다.');
  const proposal = { id: randomUUID(), matchId, proposer: proposer.role === 'team' ? { role: 'team', teamId: proposer.teamId } : { role: 'organizer', name: proposer.name.trim() }, startsAt, createdAt: new Date().toISOString(), baseRevision: revision, approvals: [], status: 'PENDING' };
  match.scheduleProposals.push(proposal);
  return proposal;
}
export function consentSchedule(item, matchId, proposalId, data, decline = false) {
  const match = find(item, matchId), proposal = match.scheduleProposals?.find(proposal => proposal.id === proposalId);
  if (!proposal) fail('일정 제안을 찾을 수 없습니다.', 404);
  if (!data || Object.keys(data).length !== 1 || typeof data.teamId !== 'string' || !match.slots.some(slot => slot.teamId === data.teamId)) fail('동의 요청은 해당 경기 참가팀의 teamId만 포함해야 합니다. 운영진은 대신 동의할 수 없습니다.', 400);
  if (match.slots.some(slot => !slot.teamId)) fail('양쪽 참가팀 확정 후에 동의할 수 있습니다.');
  if (proposal.status !== 'PENDING' || proposal.baseRevision !== (match.schedule?.revision ?? 0)) fail('이미 처리되었거나 이전 공식 일정에 대한 제안입니다. 새 제안을 사용해 주세요.');
  if (decline) { proposal.status = 'REJECTED'; proposal.declinedBy = data.teamId; proposal.rejectionReason = '참가팀이 제안을 거절했습니다.'; return { proposal, confirmed: false }; }
  if (proposal.approvals.some(approval => approval.teamId === data.teamId)) fail('이미 동의한 팀입니다.');
  proposal.approvals.push({ teamId: data.teamId, approvedAt: new Date().toISOString() });
  if (proposal.approvals.length === 2) {
    const reason = scheduleConflict(item, match, proposal.startsAt);
    if (reason || (match.schedule && (match.scheduleChangeCount ?? 0) >= 1)) {
      proposal.status = 'REJECTED'; proposal.rejectionReason = reason || '일반 일정 변경은 1회까지만 가능합니다.';
      return { proposal, confirmed: false, error: proposal.rejectionReason };
    }
    const changing = Boolean(match.schedule);
    const minutes = durationMinutes(matchFormat(item, match));
    const schedule = { startsAt: proposal.startsAt, endsAt: new Date(Date.parse(proposal.startsAt) + minutes * 60000).toISOString(), durationMinutes: minutes, revision: (match.schedule?.revision ?? 0) + 1, confirmedAt: new Date().toISOString(), proposalId: proposal.id };
    match.schedule = schedule;
    match.scheduleChangeCount = (match.scheduleChangeCount ?? 0) + (changing ? 1 : 0);
    match.scheduleHistory ??= []; match.scheduleHistory.push({ ...schedule, action: changing ? 'CHANGE' : 'INITIAL', approvedTeamIds: proposal.approvals.map(approval => approval.teamId) });
    proposal.status = 'CONFIRMED';
    for (const other of match.scheduleProposals) if (other.id !== proposal.id && other.status === 'PENDING') other.status = 'STALE';
  }
  return { proposal, confirmed: proposal.status === 'CONFIRMED', schedule: match.schedule ?? null };
}
