import { randomInt, randomUUID } from 'node:crypto';

// Fisher–Yates: every team order has equal probability. No client seed is accepted.
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildBracket(teams, { finalFormat = 'Bo1' } = {}) {
  if (teams.length < 2 || teams.length > 8) throw new Error('대진표는 2~8팀만 지원합니다.');
  const size = 2 ** Math.ceil(Math.log2(teams.length));
  const order = shuffle(teams);
  const pairs = Array.from({ length: size / 2 }, (_, index) => [order[index].id, order[size / 2 + index]?.id ?? null]);
  const firstRound = shuffle(pairs); // Randomize which branch receives each BYE.
  const rounds = [];
  for (let count = size / 2, round = 1; count >= 1; count /= 2, round++) {
    rounds.push({
      number: round,
      label: count === 1 ? '결승' : count === 2 ? '준결승' : '8강',
      matches: Array.from({ length: count }, (_, index) => ({
        id: randomUUID(), round, index, displayId: `R${round}-M${index + 1}`,
        slots: [0, 1].map(slot => ({ teamId: round === 1 ? firstRound[index][slot] : null, sourceMatchId: null, isBye: round === 1 && firstRound[index][slot] === null })),
        nextMatchId: null, nextSlotIndex: null,
        status: 'waiting', winnerTeamId: null, advancementReason: null, countsAsPlayed: false,
        resultStatus: 'PENDING', submissions: [], submissionHistory: [],
      })),
    });
  }
  rounds.forEach((round, roundIndex) => round.matches.forEach((match, index) => {
    const next = rounds[roundIndex + 1]?.matches[Math.floor(index / 2)];
    if (next) {
      match.nextMatchId = next.id; match.nextSlotIndex = index % 2;
      next.slots[index % 2].sourceMatchId = match.id;
    }
    if (roundIndex === 0 && match.slots.some(slot => slot.isBye)) {
      match.status = 'bye'; match.winnerTeamId = match.slots.find(slot => !slot.isBye).teamId;
      match.resultStatus = 'BYE';
      match.advancementReason = 'bye';
      // A BYE advances a team; it is never a played match or a match victory.
      if (next) next.slots[index % 2].teamId = match.winnerTeamId;
    }
  }));
  return {
    version: 1, id: randomUUID(), format: 'single-elimination', generatedAt: new Date().toISOString(),
    size, teamCount: teams.length, finalFormat,
    teams: teams.map(team => ({ id: team.id, name: team.name })),
    rounds,
  };
}
