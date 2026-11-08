import { resultState, matchFormat, matchFormatLabel } from './model.js';
import { durationMinutes } from './schedule-model.js';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
export const displayTime = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' (KST)';
function field(parent, name, text, type = 'datetime-local') {
  const label = el('label', text), input = document.createElement('input'); input.name = name; input.type = type; input.required = true; label.append(input); parent.append(label); return input;
}
function select(parent, name, text, options) {
  const label = el('label', text), input = document.createElement('select'); input.name = name; input.required = true;
  const placeholder = el('option', '선택'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; input.append(placeholder);
  for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
  label.append(input); parent.append(label); return input;
}
export function rulesFields(capacity) {
  const container = el('div', '', 'schedule-rules-fields');
  container.append(el('p', '일정 입력은 브라우저 현지 시간 기준입니다. 저장은 UTC, 표시된 공식 일정은 한국 시간(KST)입니다. 규칙은 한 번 저장하면 변경할 수 없습니다.'));
  field(container, 'eventStart', '대회 시작'); field(container, 'eventEnd', '대회 종료');
  const max = field(container, 'maxConcurrent', '최대 동시 경기 수', 'number'); max.min = '1'; max.max = '4'; max.value = '1';
  for (let size = 2; size <= 2 ** Math.ceil(Math.log2(Math.min(capacity, 8))); size *= 2) {
    const name = size === 2 ? '결승' : size === 4 ? '준결승' : '8강';
    field(container, `round${size}Start`, `${name} 시작`); field(container, `round${size}End`, `${name} 종료`);
  }
  return container;
}
export function readRules(form, capacity) {
  const data = new FormData(form), iso = name => { const value = data.get(name); if (!value) throw new Error('대회 및 라운드 기간을 모두 입력해 주세요.'); return new Date(value).toISOString(); };
  const rules = { startsAt: iso('eventStart'), endsAt: iso('eventEnd'), maxConcurrent: Number(data.get('maxConcurrent')), rounds: {} };
  for (let size = 2; size <= 2 ** Math.ceil(Math.log2(Math.min(capacity, 8))); size *= 2) rules.rounds[size] = { startsAt: iso(`round${size}Start`), endsAt: iso(`round${size}End`) };
  return rules;
}
export function tournamentScheduling(item) {
  const section = el('section', '', 'schedule-configuration'); section.append(el('h3', '대회 일정 규칙'));
  if (!item.scheduling) {
    section.append(el('p', '일정 규칙 미설정 · 개최자만 최초 설정할 수 있습니다.', 'notice'));
    if (item.permissions.manage) { const form = el('form', '', 'schedule-rules-form'); form.append(rulesFields(item.capacity)); const button = el('button', '일정 규칙 저장 (개최자)'); button.type = 'submit'; form.append(button); section.append(form); }
  } else {
    section.append(el('p', `${displayTime(item.scheduling.startsAt)} ~ ${displayTime(item.scheduling.endsAt)} · 최대 동시 ${item.scheduling.maxConcurrent}경기`));
    for (const [size, window] of Object.entries(item.scheduling.rounds)) section.append(el('p', `${size === '2' ? '결승' : size === '4' ? '준결승' : '8강'}: ${displayTime(window.startsAt)} ~ ${displayTime(window.endsAt)}`, 'muted'));
  }
  return section;
}
export function matchScheduling(item, match, names) {
  const section = el('section', '', 'match-scheduling'); section.dataset.matchId = match.id;
  if (resultState(match) === 'BYE') { section.append(el('p', 'BYE · 일정 합의 제외', 'muted')); return section; }
  section.append(el('h6', '경기 일정 합의'));
  section.append(el('p', match.schedule ? `공식 일정: ${displayTime(match.schedule.startsAt)} ~ ${displayTime(match.schedule.endsAt)}` : '공식 일정 미확정', 'official-schedule'));
  const displayFormat = matchFormatLabel(item, match);
  section.append(el('p', `${displayFormat}${displayFormat === '경기 방식 미설정' ? ` (기존 일정 계산 기준 ${matchFormat(item, match)})` : ''} 예상 ${durationMinutes(matchFormat(item, match))}분 · 강제 종료 제한시간 아님 · 일반 변경 ${match.scheduleChangeCount ?? 0}/1회`, 'muted'));
  for (const history of match.scheduleHistory ?? []) section.append(el('p', `확정 이력 #${history.revision}: ${displayTime(history.startsAt)} · ${history.action === 'INITIAL' ? '최초 확정' : '양 팀 동의 변경'}`, 'schedule-history'));
  const teams = match.slots.filter(slot => slot.teamId).map(slot => [slot.teamId, names.get(slot.teamId)]);
  const owned = teams.filter(([id]) => item.permissions.teamIds.includes(id));
  for (const proposal of match.scheduleProposals ?? []) {
    const card = el('article', '', 'schedule-proposal'); card.dataset.proposalId = proposal.id;
    const proposer = proposal.proposer.role === 'organizer' ? `개최자 ${proposal.proposer.name}` : names.get(proposal.proposer.teamId);
    card.append(el('p', `제안: ${displayTime(proposal.startsAt)} · ${proposer} · ${proposal.status}`, 'proposal-time'), el('p', `생성: ${displayTime(proposal.createdAt)}`, 'muted'));
    for (const [id, name] of teams) card.append(el('p', `${name}: ${proposal.approvals.some(approval => approval.teamId === id) ? '동의 완료' : '미동의'}`, 'consent-state'));
    if (proposal.rejectionReason) card.append(el('p', proposal.rejectionReason, 'schedule-error'));
    if (proposal.status === 'PENDING' && teams.length === 2 && owned.length > 0) {
      const form = el('form', '', 'schedule-consent-form'); form.dataset.matchId = match.id; form.dataset.proposalId = proposal.id;
      select(form, 'teamId', '동의/거절 팀 (로그인한 대표자)', owned).value = owned[0][0];
      for (const [action, text] of [['consent', '이 제안에 동의'], ['decline', '이 제안 거절']]) { const button = el('button', text); button.type = 'submit'; button.name = 'decision'; button.value = action; form.append(button); }
      card.append(form);
    }
    section.append(card);
  }
  if (!item.scheduling) section.append(el('p', '일정 규칙을 먼저 설정해 주세요.'));
  else if (match.schedule && (match.scheduleChangeCount ?? 0) >= 1) section.append(el('p', '일반 일정 변경 1회를 사용했습니다. 추가 변경은 지원하지 않습니다.'));
  else if (!item.permissions.legacyReadOnly && (owned.length > 0 || item.permissions.manage)) {
    const form = el('form', '', 'schedule-proposal-form'); form.dataset.matchId = match.id;
    const choices = [...owned, ...(item.permissions.manage ? [['organizer', '개최자']] : [])];
    select(form, 'proposer', '일정 제안 자격', choices).value = choices[0][0];
    field(form, 'startsAt', '후보 시작 일시'); const button = el('button', '일정 제안'); button.type = 'submit'; form.append(button); section.append(form);
    if (teams.length !== 2) section.append(el('p', '참가팀 미정: 개최자 제안만 가능하며 공식 확정은 양 팀 확정 후 가능합니다.', 'muted'));
  }
  return section;
}
