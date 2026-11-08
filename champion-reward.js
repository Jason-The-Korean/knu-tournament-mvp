import { immediateTransaction } from './transaction.js';

export const CHAMPION_REWARD = Object.freeze({ winAmount: 200, participationAmount: 0, policyVersion: 'demo-v0.1' });
export function migrateChampionRewards(db) {
  immediateTransaction(db, () => db.exec(`CREATE TABLE IF NOT EXISTS point_reward_eligibility (
    tournament_id TEXT PRIMARY KEY NOT NULL REFERENCES tournaments(id),
    policy_version TEXT NOT NULL,
    win_amount INTEGER NOT NULL CHECK(typeof(win_amount)='integer' AND win_amount BETWEEN 1 AND 9007199254740991),
    participation_amount INTEGER NOT NULL DEFAULT 0 CHECK(participation_amount=0),
    enabled_at TEXT NOT NULL
  );`));
}
export function championRewards(db, points) {
  const policy = id => db.prepare('SELECT * FROM point_reward_eligibility WHERE tournament_id=?').get(id) ?? null;
  return {
    policy,
    enable(id, instant) {
      db.prepare('INSERT INTO point_reward_eligibility VALUES (?,?,?,?,?)').run(id, CHAMPION_REWARD.policyVersion, CHAMPION_REWARD.winAmount, CHAMPION_REWARD.participationAmount, new Date(instant).toISOString());
    },
    award(item, matchId, previousChampionId) {
      if (previousChampionId || !item.bracket.championTeamId) return;
      const reward = policy(item.id); if (!reward) return; // Legacy events remain non-rewarding.
      const final = item.bracket.rounds.at(-1);
      const match = final?.matches.length === 1 ? final.matches[0] : null;
      const winner = item.bracket.championTeamId;
      const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
      if (item.status === 'CANCELLED' || !match || match.id !== matchId || match.nextMatchId || match.resultStatus !== 'CONFIRMED' || !match.countsAsPlayed || match.advancementReason !== 'match_result' || match.winnerTeamId !== winner || !item.bracket.completedAt) fail('우승 보상 대상 결승 확정 상태가 올바르지 않습니다.');
      if (!item.teams.some(t => t.id === winner) || !match.slots.some(s => s.teamId === winner)) fail('우승팀이 해당 대회의 실제 참가팀이 아닙니다.');
      const representative = db.prepare('SELECT o.user_id FROM team_owners o JOIN users u ON u.id=o.user_id JOIN teams t ON t.id=o.team_id WHERE o.team_id=? AND o.tournament_id=? AND t.tournament_id=?').get(winner, item.id, item.id);
      if (!representative) fail('우승팀 대표자 계정 연결이 없거나 올바르지 않아 결승 확정을 취소했습니다.');
      points.changeInTransaction({ userId: representative.user_id, delta: reward.win_amount, type: 'TOURNAMENT_WIN', reason: '대회 우승 데모 보상', policyVersion: reward.policy_version, tournamentId: item.id, teamId: winner, matchId, idempotencyKey: `tournament-win:${item.id}` });
    },
  };
}
