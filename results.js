import { resultState, matchFormat, validateResult } from './public/model.js';

function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
// Called only within the store's BEGIN IMMEDIATE transaction.
export function applyResult(tournament, matchId, data) {
  const bracket = tournament.bracket;
  if (!bracket) fail('대진표가 없습니다.');
  const matches = bracket.rounds.flatMap(round => round.matches);
  const match = matches.find(item => item.id === matchId);
  if (!match) fail('경기를 찾을 수 없습니다.', 404);
  if (resultState(match) === 'BYE') fail('BYE 경기는 결과 제출 대상이 아닙니다.');
  if (resultState(match) === 'CONFIRMED' || match.winnerTeamId) fail('확정된 경기 결과는 다시 제출하거나 변경할 수 없습니다.');
  if (match.slots.some(slot => !slot.teamId)) fail('양 팀이 모두 결정된 후 제출할 수 있습니다.');
  const error = validateResult(match, data, matchFormat(tournament, match));
  if (error) fail(error, 400);
  match.submissions ??= []; match.submissionHistory ??= [];
  const previous = match.submissions.find(submission => submission.teamId === data.teamId);
  if (previous && previous.winnerTeamId === data.winnerTeamId && previous.score.every((score, index) => score === data.score[index])) fail('이미 제출한 동일한 결과입니다.');
  const submission = { teamId: data.teamId, winnerTeamId: data.winnerTeamId, score: [...data.score], submittedAt: new Date().toISOString(), revision: match.submissionHistory.length + 1 };
  match.submissions = [...match.submissions.filter(item => item.teamId !== data.teamId), submission];
  match.submissionHistory.push(submission);
  if (match.submissions.length === 1) match.resultStatus = 'AWAITING_CONFIRMATION';
  else {
    const [first, second] = match.submissions;
    if (first.winnerTeamId !== second.winnerTeamId || first.score.some((score, index) => score !== second.score[index])) match.resultStatus = 'DISPUTED';
    else {
      if (match.nextMatchId) {
        const next = matches.find(item => item.id === match.nextMatchId);
        const slot = next?.slots[match.nextSlotIndex];
        if (!slot || slot.sourceMatchId !== match.id || (slot.teamId && slot.teamId !== first.winnerTeamId) || resultState(next) !== 'PENDING') fail('다음 경기 상태가 올바르지 않아 확정하지 못했습니다.');
        slot.teamId = first.winnerTeamId;
      } else bracket.championTeamId = first.winnerTeamId;
      match.resultStatus = 'CONFIRMED'; match.status = 'completed';
      match.winnerTeamId = first.winnerTeamId; match.score = [...first.score];
      match.advancementReason = 'match_result'; match.countsAsPlayed = true;
      match.confirmedAt = new Date().toISOString();
      if (!match.nextMatchId) bracket.completedAt = match.confirmedAt;
    }
  }
  return bracket;
}
