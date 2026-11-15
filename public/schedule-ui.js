import { resultState, matchFormat, matchFormatLabel, kstInputToIso } from './model.js';
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
export function rulesFields(capacity, kst = false) {
  const container = el('div', '', 'schedule-rules-fields');
  container.append(el('p', kst ? '한국 시간(KST)으로 입력하세요. 대회 시작 시각과 같아야 합니다.' : '입력은 기기 시간, 표시는 한국 시간(KST) 기준입니다. 한 번 저장하면 바꿀 수 없습니다.'));
  field(container, 'eventStart', '대회 시작'); field(container, 'eventEnd', '대회 종료');
  const max = field(container, 'maxConcurrent', '최대 동시 경기 수', 'number'); max.min = '1'; max.max = '4'; max.value = '1';
  for (let size = 2; size <= 2 ** Math.ceil(Math.log2(Math.min(capacity, 8))); size *= 2) {
    const name = size === 2 ? '결승' : size === 4 ? '준결승' : '8강';
    field(container, `round${size}Start`, `${name} 시작`); field(container, `round${size}End`, `${name} 종료`);
  }
  return container;
}
export function readRules(form, capacity, kst = false) {
  const data = new FormData(form), iso = name => { const value = data.get(name); if (!value) throw new Error('대회 및 라운드 기간을 모두 입력해 주세요.'); return kst ? kstInputToIso(value) : new Date(value).toISOString(); };
  const rules = { startsAt: iso('eventStart'), endsAt: iso('eventEnd'), maxConcurrent: Number(data.get('maxConcurrent')), rounds: {} };
  for (let size = 2; size <= 2 ** Math.ceil(Math.log2(Math.min(capacity, 8))); size *= 2) rules.rounds[size] = { startsAt: iso(`round${size}Start`), endsAt: iso(`round${size}End`) };
  return rules;
}
export function tournamentScheduling(item) {
  const section = el(item.scheduling ? 'section' : 'details', '', 'schedule-configuration'); section.append(el(item.scheduling ? 'h3' : 'summary', item.scheduling ? '경기 시간' : item.permissions.manage ? '경기 시간 설정 (선택)' : '경기 시간 안내'));
  if (!item.scheduling) {
    section.append(el('p', item.permissions.manage ? '경기별 일정을 제안하려면 먼저 경기 시간을 설정해 주세요. 대진표는 시간 설정 없이도 만들 수 있습니다.' : '개최자가 경기 시간을 설정한 뒤 양 팀이 일정을 정합니다.', 'notice'));
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
  section.append(el('p', match.schedule ? `공식 일정: ${displayTime(match.schedule.startsAt)} ~ ${displayTime(match.schedule.endsAt)}` : item.bracket?.championTeamId ? '기록된 경기 일정이 없습니다.' : !item.scheduling ? '개최자가 경기 시간을 설정하면 일정을 정할 수 있습니다.' : match.slots.some(slot=>!slot.teamId) ? '양 팀이 정해지면 경기 일정을 제안할 수 있습니다.' : '양 팀이 같은 일정에 동의하면 확정됩니다.', 'official-schedule'));
  const displayFormat = matchFormatLabel(item, match);
  section.append(el('p', `${displayFormat}${displayFormat === '경기 방식 미설정' ? ` (기존 일정 계산 기준 ${matchFormat(item, match)})` : ''} 예상 ${durationMinutes(matchFormat(item, match))}분 · 강제 종료 제한시간 아님 · 일반 변경 ${match.scheduleChangeCount ?? 0}/1회`, 'muted'));
  for (const history of match.scheduleHistory ?? []) section.append(el('p', `확정 이력 #${history.revision}: ${displayTime(history.startsAt)} · ${history.action === 'INITIAL' ? '최초 확정' : '양 팀 동의 변경'}`, 'schedule-history'));
  const teams = match.slots.filter(slot => slot.teamId).map(slot => [slot.teamId, names.get(slot.teamId)]);
  const owned = teams.filter(([id]) => item.permissions.teamIds.includes(id));
  for (const proposal of match.scheduleProposals ?? []) {
    const card = el('article', '', 'schedule-proposal'); card.dataset.proposalId = proposal.id;
    const proposer = proposal.proposer.role === 'organizer' ? `개최자 ${proposal.proposer.name}` : names.get(proposal.proposer.teamId);
    const statusLabel = { PENDING: '동의 대기', CONFIRMED: '확정', REJECTED: '거절됨', STALE: '이전 제안' }[proposal.status] ?? '상태 확인 필요';
    card.append(el('p', `제안: ${displayTime(proposal.startsAt)} · ${proposer} · ${statusLabel}`, 'proposal-time'), el('p', `제안 시각: ${displayTime(proposal.createdAt)}`, 'muted'));
    for (const [id, name] of teams) card.append(el('p', `${name}: ${proposal.approvals.some(approval => approval.teamId === id) ? '동의 완료' : '미동의'}`, 'consent-state'));
    if (proposal.rejectionReason) card.append(el('p', proposal.rejectionReason, 'schedule-error'));
    if (proposal.status === 'PENDING' && teams.length === 2 && owned.length > 0) {
      const form = el('form', '', 'schedule-consent-form'); form.dataset.matchId = match.id; form.dataset.proposalId = proposal.id;
      select(form, 'teamId', '내 팀', owned).value = owned[0][0];
      for (const [action, text] of [['consent', '이 제안에 동의'], ['decline', '이 제안 거절']]) { const button = el('button', text); button.type = 'submit'; button.name = 'decision'; button.value = action; form.append(button); }
      card.append(form);
    }
    section.append(card);
  }
  if (!item.scheduling) section.append(el('p', item.permissions.manage ? '‘경기 일정’ 탭에서 경기 시간을 먼저 설정해 주세요.' : '개최자의 경기 시간 설정을 기다려 주세요.'));
  else if (match.schedule && (match.scheduleChangeCount ?? 0) >= 1) section.append(el('p', '일반 일정 변경 1회를 사용했습니다. 추가 변경은 지원하지 않습니다.'));
  else if (!item.permissions.legacyReadOnly && (owned.length > 0 || item.permissions.manage)) {
    const form = el('form', '', 'schedule-proposal-form'); form.dataset.matchId = match.id;
    const choices = [...owned, ...(item.permissions.manage ? [['organizer', '개최자']] : [])];
    select(form, 'proposer', '제안자', choices).value = choices[0][0];
    field(form, 'startsAt', '후보 시작 일시'); const button = el('button', '일정 제안'); button.type = 'submit'; form.append(button); section.append(form);
    if (teams.length !== 2) section.append(el('p', '참가팀 미정: 개최자 제안만 가능하며 공식 확정은 양 팀 확정 후 가능합니다.', 'muted'));
  }
  return section;
}
