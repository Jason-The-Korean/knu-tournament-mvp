export function isInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;
}
export const roundSize = (tournament, match) => 2 ** (tournament.bracket.rounds.length - match.round + 1);
export function validateScheduleRules(rules, capacity) {
  if (!rules || !isInstant(rules.startsAt) || !isInstant(rules.endsAt) || Date.parse(rules.startsAt) >= Date.parse(rules.endsAt)) return '대회 시작·종료를 시간대가 포함된 올바른 일시로 입력해 주세요.';
  if (!Number.isInteger(rules.maxConcurrent) || rules.maxConcurrent < 1 || rules.maxConcurrent > 4) return '최대 동시 경기 수는 1~4경기여야 합니다.';
  if (!rules.rounds || typeof rules.rounds !== 'object' || Array.isArray(rules.rounds)) return '라운드별 기간이 필요합니다.';
  const size = 2 ** Math.ceil(Math.log2(Math.min(capacity, 8)));
  for (let round = 2; round <= size; round *= 2) {
    const window = rules.rounds[round];
    if (!window || !isInstant(window.startsAt) || !isInstant(window.endsAt) || Date.parse(window.startsAt) >= Date.parse(window.endsAt)) return `${round === 2 ? '결승' : round === 4 ? '준결승' : '8강'} 시작·종료 기간을 입력해 주세요.`;
    if (Date.parse(window.startsAt) < Date.parse(rules.startsAt) || Date.parse(window.endsAt) > Date.parse(rules.endsAt)) return '라운드 기간은 대회 전체 기간 안에 있어야 합니다.';
  }
  return '';
}
export const durationMinutes = format => format === 'Bo3' ? 210 : 90;
