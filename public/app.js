import { today, validateTournament, validateTeam, registrationReason, kstInputToIso, displayKst, kstDate, canCancelUnderfilled, approvedTeamCount } from './model.js';
import { closeReason, closingPolicy } from './model.js';
import { resultState, matchFormat, matchFormatLabel } from './model.js';
import { rulesFields, readRules, tournamentScheduling, matchScheduling } from './schedule-ui.js';
import { filterTournaments, tournamentStage, typeLabel, scopeLabel } from './arena.js';
import { FAVORITES_KEY, loadFavorites, saveFavorites } from './favorites.js';
import { detailLayout, restoreDetailTab, activateDetailTab } from './detail-ui.js';
import { enhanceBracket, teamButton } from './bracket-ui.js';
import { rulesPanel } from './rules-ui.js';
const $ = id => document.getElementById(id);
let tournaments = [];
let currentUser = null, csrfToken = '';
let pendingAction = null, modalTrigger = null, authBusy = false;
let routeVersion = 0;
const filters = { status: 'all', type: 'all', scope: 'all', query: '', favorites: false };
const favorites = new Set();
let favoritesReady = true;
function storageNotice(text) { $('storage-notice').textContent = text; $('storage-notice').hidden = !text; }
function readSavedFavorites() {
  try { const saved = loadFavorites(localStorage); favorites.clear(); saved.forEach(id => favorites.add(id)); favoritesReady = true; storageNotice(''); }
  catch { favoritesReady = false; storageNotice('관심 목록을 읽을 수 없습니다. 기존 저장값을 보존하며 관심 변경을 중지했습니다. 브라우저 저장소 설정을 확인해 주세요.'); }
}
readSavedFavorites();
$('guide-rules').replaceChildren(rulesPanel());
async function api(path = '/api/tournaments', data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { currentUser = null; authDisplay(); } throw new Error(result.error || '요청에 실패했습니다.'); }
  return result;
}
function authDisplay() {
  $('auth-status').textContent = currentUser ? `${currentUser.displayName} (${currentUser.username}) 로그인 중` : '비로그인 · 목록과 공개 대진표를 볼 수 있습니다.';
  $('auth-forms').hidden = Boolean(currentUser); $('logout').hidden = !currentUser;
  $('login-open').hidden = Boolean(currentUser); $('auth-status').classList.toggle('sr-only', !currentUser);
  $('account-open').hidden = !currentUser;
  $('account-label').textContent = currentUser ? `${currentUser.displayName} (${currentUser.username})` : '';
  if (!currentUser && $('account-panel').matches(':popover-open')) $('account-panel').hidePopover();
  $('create-form').hidden = !currentUser; $('create-auth-notice').hidden = Boolean(currentUser);
}
function updateAuthButtons() {
  for (const id of ['login-form', 'signup-form']) $(id).querySelector('button[type=submit]').disabled = authBusy || !$(id).checkValidity();
}
function authMode(register = false) {
  $('auth-title').textContent = register ? '회원가입' : '로그인';
  $('login-form').hidden = register; $('signup-form').hidden = !register; $('auth-error').textContent = '';
  $('auth-close').setAttribute('aria-label', register ? '회원가입 창 닫기' : '로그인 창 닫기');
  updateAuthButtons();
  $(register ? 'signup-username' : 'login-username').focus();
}
function openAuth(register = false) {
  authMode(register); $('auth-dialog').returnValue = '';
  if (!$('auth-dialog').open) $('auth-dialog').showModal();
  $(register ? 'signup-username' : 'login-username').focus();
}
function requestLogin(action, trigger = document.activeElement) {
  pendingAction = action; modalTrigger = trigger;
  $('required-message').textContent = action.type === 'join' ? '대회에 참가하려면 로그인이 필요합니다.' : '대회를 개최하려면 로그인이 필요합니다.';
  $('required-next').textContent = action.type === 'join' ? '로그인 후 참가 신청 화면으로 계속 진행할 수 있습니다.' : '로그인 후 대회 생성 화면으로 계속 진행할 수 있습니다.';
  $('login-required-dialog').returnValue = '';
  if (!$('login-required-dialog').open) $('login-required-dialog').showModal();
  $('required-login').focus();
}
function restoreModalFocus() { if (modalTrigger?.isConnected) modalTrigger.focus(); }
$('login-open').addEventListener('click', () => { pendingAction = null; modalTrigger = $('login-open'); openAuth(); });
$('auth-close').addEventListener('click', () => $('auth-dialog').close('cancel'));
$('show-signup').addEventListener('click', () => authMode(true));
$('show-login').addEventListener('click', () => authMode(false));
$('required-login').addEventListener('click', () => $('login-required-dialog').close('login'));
$('required-cancel').addEventListener('click', () => $('login-required-dialog').close('cancel'));
$('login-required-dialog').addEventListener('close', () => {
  if ($('login-required-dialog').returnValue === 'login') openAuth();
  else { pendingAction = null; restoreModalFocus(); }
});
$('auth-dialog').addEventListener('close', () => {
  $('login-password').value = ''; $('signup-password').value = ''; updateAuthButtons();
  if ($('auth-dialog').returnValue !== 'success') { pendingAction = null; restoreModalFocus(); }
});
for (const id of ['auth-dialog', 'login-required-dialog', 'recruit-close-dialog']) $(id).addEventListener('click', event => {
  const dialog = $(id), rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close('cancel');
});
for (const id of ['auth-dialog', 'login-required-dialog', 'recruit-close-dialog']) $(id).addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const dialog = $(id);
  const items = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
  const first = items[0], last = items.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
});
for (const id of ['login-form', 'signup-form']) $(id).addEventListener('input', updateAuthButtons);
document.addEventListener('click', event => {
  const createLink = event.target.closest('a[href="#create"]');
  if (createLink && !currentUser) { event.preventDefault(); requestLogin({ type: 'create' }, createLink); }
  const browseLink = event.target.closest('a[data-browse], .header-browse');
  if (browseLink) {
    event.preventDefault(); history.pushState(null, '', '#list');
    route().then(() => { $('list-title').tabIndex = -1; $('list-title').focus({ preventScroll: true }); $('list-view').scrollIntoView({ block: 'start' }); });
  }
});
async function resumeAction(action) {
  if (action?.type === 'create') history.pushState(null, '', '#create');
  else if (action?.type === 'join') history.pushState(null, '', `#detail/${action.id}`);
  await route();
  if (action?.type === 'create') $('name').focus();
  else if (action?.type === 'join' && !$('team-form').hidden) { $('team-name').focus(); $('team-form').scrollIntoView({ block: 'start' }); }
  else $('logout').focus();
}
async function refreshSession() { const state = await api('/api/auth/session'); currentUser = state.user; csrfToken = state.csrfToken; authDisplay(); }
for (const [id, register] of [['login-form', false], ['signup-form', true]]) $(id).addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; authBusy = true; updateAuthButtons(); $('auth-error').textContent = '';
  const username = $(register ? 'signup-username' : 'login-username').value, password = $(register ? 'signup-password' : 'login-password').value;
  try {
    await refreshSession();
    let signupBonus;
    if (register) { const result = await api('/api/auth/register', { username, password, displayName: $('signup-name').value }); signupBonus = result.signupBonus; }
    const state = await api('/api/auth/login', { username, password }); currentUser = state.user; csrfToken = state.csrfToken; $(id).reset();
    const action = pendingAction; pendingAction = null; $('auth-dialog').close('success'); authDisplay(); await resumeAction(action);
    if (signupBonus) $('message').textContent = `회원가입이 완료되어 데모 보너스 ${signupBonus.amount}P가 지급되었습니다. 현금·기프티콘 교환은 지원하지 않습니다.`;
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $(register ? 'signup-password' : 'login-password').value = ''; authBusy = false; updateAuthButtons(); }
});
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', {}); await refreshSession(); await route(); } catch (error) { $('auth-error').textContent = error.message; } });
function element(tag, text, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render() {
  const shown = filterTournaments(tournaments, filters, favorites);
  $('favorites-only').setAttribute('aria-pressed', String(filters.favorites));
  $('count').textContent = `${shown.length} / ${tournaments.length}개`;
  for (const key of ['status', 'type', 'scope']) document.querySelectorAll(`[data-${key}]`).forEach(button => button.setAttribute('aria-pressed', String(button.dataset[key] === filters[key])));
  const menu = location.hash === '#guide' ? 'guide' : filters.type === 'all' ? 'home' : filters.type;
  document.querySelectorAll('[data-menu]').forEach(link => { if (link.dataset.menu === menu) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('tournaments').replaceChildren();
  if (!shown.length) $('tournaments').append(element('div', tournaments.length ? '조건에 맞는 대회가 없습니다. 검색어와 필터를 조정해 보세요.' : '아직 등록된 대회가 없습니다. 첫 대회를 만들어 보세요.', 'empty'));
  $('filter-description').textContent = '유형·참가 범위 미설정 대회는 특정 유형·범위 필터에서 제외됩니다.';
  for (const item of [...shown].sort((a, b) => a.date.localeCompare(b.date))) {
    const card = element('article', '', 'card tournament-card'); card.dataset.tournamentId = item.id;
    const stage = tournamentStage(item), status = element('p', `${typeLabel(item)} · ${stage.label}`, 'card-status'); status.title = stage.reason;
    const link = element('a', '', 'card-link'); link.href = `#detail/${item.id}`;
    link.append(element('h3', item.name), element('p', `${scopeLabel(item)} · LoL 5인 팀`, 'card-meta'));
    const footer = element('div', '', 'card-footer'); footer.append(element('span', `${item.teams.length} / ${item.capacity}팀`), element('span', `${item.date.slice(5, 7)}월 ${item.date.slice(8, 10)}일`, 'card-date'));
    card.append(status, link, footer);
    card.append(element('p', item.recruitEndAt ? `모집 마감 ${displayKst(item.recruitEndAt)}` : '모집 마감 일시 미설정 · 기존 정책 적용', 'muted recruitment-deadline'));
    const bookmark = element('button', '', 'bookmark-button'); bookmark.type = 'button'; bookmark.dataset.favorite = item.id; bookmark.disabled = !favoritesReady;
    bookmark.setAttribute('aria-label', `${item.name} 관심 ${favorites.has(item.id) ? '해제' : '등록'}`); bookmark.setAttribute('aria-pressed', String(favorites.has(item.id)));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4V4Z'); svg.append(path); bookmark.append(svg); card.append(bookmark);
    if (item.permissions.legacyReadOnly) card.append(element('p', '기존 데모 · 읽기 전용', 'card-note'));
    else if (!registrationReason(item) && !item.permissions.teamIds.length) { const apply = element('a', '참가 신청', 'card-apply'); apply.href = link.href; apply.dataset.cardJoin = item.id; card.append(apply); }
    $('tournaments').append(card);
  }
}
$('tournaments').addEventListener('click', event => {
  const button = event.target.closest('[data-favorite]'); if (!button || !favoritesReady) return;
  const next = new Set(favorites); const id = button.dataset.favorite;
  if (next.has(id)) next.delete(id); else next.add(id);
  try {
    saveFavorites(localStorage, next); favorites.clear(); next.forEach(value => favorites.add(value));
    storageNotice(next.has(id) ? '관심 대회에 저장했습니다. 이 브라우저에서만 유지됩니다.' : '관심 대회에서 해제했습니다.'); render();
    const replacement = [...document.querySelectorAll('[data-favorite]')].find(node => node.dataset.favorite === id);
    (replacement ?? $('favorites-only')).focus({ preventScroll: true });
  } catch { storageNotice('관심 대회를 저장하지 못했습니다. 브라우저 저장 공간·설정을 확인해 주세요.'); }
});
$('favorites-only').addEventListener('click', () => { filters.favorites = !filters.favorites; render(); });
window.addEventListener('storage', event => { if (event.key === FAVORITES_KEY) { readSavedFavorites(); render(); } });
function showGuideTab(rules) {
  $('guide-use').hidden = rules; $('guide-rules').hidden = !rules;
  for (const [id, selected] of [['guide-use-tab', !rules], ['guide-rules-tab', rules]]) { $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1; }
}
for (const [id, rules] of [['guide-use-tab', false], ['guide-rules-tab', true]]) {
  $(id).addEventListener('click', () => showGuideTab(rules));
  $(id).addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? false : event.key === 'End' ? true : !rules; showGuideTab(target); $(target ? 'guide-rules-tab' : 'guide-use-tab').focus(); } });
}
for (const key of ['status', 'type', 'scope']) $(`${key}-filters`).addEventListener('click', event => {
  const button = event.target.closest(`[data-${key}]`); if (!button) return;
  filters[key] = button.dataset[key];
  if (key === 'type') history.pushState(null, '', filters.type === 'all' ? '#list' : `#${filters.type}`);
  render();
});
$('tournament-search').addEventListener('input', event => { filters.query = event.target.value; render(); });
$('reset-filters').addEventListener('click', () => { Object.assign(filters, { status: 'all', type: 'all', scope: 'all', query: '', favorites: false }); $('tournament-search').value = ''; history.replaceState(null, '', '#list'); render(); });
$('search-open').addEventListener('click', async () => { history.pushState(null, '', filters.type === 'all' ? '#list' : `#${filters.type}`); await route(); $('tournament-search').focus(); $('tournament-search').scrollIntoView({ block: 'center' }); });
document.addEventListener('click', async event => {
  const link = event.target.closest('[data-card-join]'); if (!link) return;
  event.preventDefault();
  if (!currentUser) requestLogin({ type: 'join', id: link.dataset.cardJoin }, link);
  else { history.pushState(null, '', `#detail/${link.dataset.cardJoin}`); await route(); if (!$('team-form').hidden) { $('team-name').focus(); $('team-form').scrollIntoView({ block: 'start' }); } }
});
function themeControls() { document.querySelectorAll('[name=arena-theme]').forEach(input => { input.checked = input.value === window.arenaTheme.get(); }); }
document.querySelectorAll('[name=arena-theme]').forEach(input => input.addEventListener('change', () => { if (!window.arenaTheme.set(input.value)) $('message').textContent = '테마는 적용했지만 브라우저 저장소에 저장하지 못했습니다. 현재 화면에서만 유지됩니다.'; }));
window.addEventListener('arena-theme-change', themeControls); themeControls();
function selectedId() { return location.hash.startsWith('#detail/') ? location.hash.slice(8) : null; }
function showDetail(item) {
  $('detail-view').append($('join-button'));
  $('detail-view').append($('team-form'));
  $('detail-content').replaceChildren();
  if (!item) { $('detail-content').append(element('p', '대회를 찾을 수 없습니다.')); $('team-form').hidden = true; $('join-button').hidden = true; return; }
  const reason = registrationReason(item);
  const layout = detailLayout(item, $('join-button'));
  $('detail-content').append(layout.root);
  if (item.permissions.legacyReadOnly) $('detail-content').append(element('p', '기존 데모 · 소유자와 대표자를 확인할 수 없어 읽기 전용으로 보존합니다. 새 대회를 생성해 사용해 주세요.', 'notice'));
  layout.home.append(element('p', reason || '모집 중 · 선착순 자동 승인', 'notice'));
  if (!item.teams.length) layout.participants.append(element('p', '아직 참가팀이 없습니다.'));
  for (const team of item.teams) {
    const card = element('article', '', 'card');
    card.append(teamButton(item, team), element('p', '참가 승인 완료 · 팀을 선택하면 공개 가능한 상세 정보를 표시합니다.'));
    layout.participants.append(card);
  }
  $('team-form').hidden = Boolean(reason) || !currentUser || item.permissions.legacyReadOnly || item.permissions.teamIds.length > 0;
  $('join-button').hidden = Boolean(reason) || item.permissions.legacyReadOnly || item.permissions.teamIds.length > 0;
  layout.home.append(element('p', closingPolicy(item), 'notice'));
  if (item.status !== 'CANCELLED') layout.bracket.append(tournamentScheduling(item));
  showBracket(item);
  layout.bracket.append($('detail-content').querySelector('.bracket-section'));
  enhanceBracket(item, layout.bracket);
  layout.home.append($('team-form'));
  restoreDetailTab(item);
}
$('join-button').addEventListener('click', () => {
  activateDetailTab('event-home');
  if (!currentUser) requestLogin({ type: 'join', id: selectedId() }, $('join-button'));
  else { $('team-name').focus(); $('team-form').scrollIntoView({ block: 'start' }); }
});
function showBracket(item) {
  const section = element('section', '', 'bracket-section');
  section.setAttribute('aria-label', '토너먼트 대진표');
  section.append(element('h3', '싱글 엘리미네이션 대진표'));
  if (['Bo1', 'Bo3'].includes(item.finalFormat)) section.append(element('p', `결승 ${item.finalFormat}`));
  if (item.status === 'CANCELLED') {
    section.append(element('p', '취소된 대회입니다. 참가팀 기록은 보존되며 대진표를 생성할 수 없습니다.', 'notice'));
    $('detail-content').append(section); return;
  }
  if (!item.bracket) {
    section.append(element('p', '모집을 마감한 뒤 무작위로 한 번 생성합니다. 재추첨과 팀 위치 변경은 불가능합니다.', 'muted'));
    const button = element('button', item.status === 'closed' ? '무작위 대진표 생성 (재추첨 불가)' : '참가 모집 마감');
    button.type = 'button'; button.dataset.action = item.status === 'closed' ? 'bracket' : 'close';
    const reason = item.status === 'closed'
      ? (item.teams.length < 2 || item.teams.length > 8 || item.capacity > 8 ? '정원 2~8팀 대회에 최소 2팀이 참가해야 합니다.' : '')
      : closeReason(item);
    button.disabled = Boolean(reason); if (item.permissions.manage) section.append(button);
    if (reason) section.append(element('p', reason, 'muted'));
  } else {
    section.append(element('p', `대진 확정 · ${item.bracket.teamCount}팀 · 재추첨 불가 · BYE는 실제 경기 승리로 집계되지 않습니다.`, 'notice'));
    const grid = element('div', '', 'bracket-grid');
    const teamNames = new Map(item.bracket.teams.map(team => [team.id, team.name]));
    if (item.bracket.championTeamId) section.append(element('h3', `최종 우승팀: ${teamNames.get(item.bracket.championTeamId)}`, 'champion'));
    section.append(element('p', '로그인한 팀 대표자만 자기 팀의 결과·일정 동의를 제출할 수 있습니다. 학교 이메일·Riot 계정 소유권·실제 경기 종료 검증은 제공하지 않습니다.', 'notice'));
    const matches = new Map(item.bracket.rounds.flatMap(round => round.matches.map(match => [match.id, match])));
    for (const round of item.bracket.rounds) {
      const column = element('section', '', 'bracket-round');
      column.append(element('h4', `${round.label} · ${round.matches.length}경기`));
      for (const match of round.matches) {
        const card = element('article', '', `match-card${match.status === 'bye' ? ' bye-match' : ''}`);
        card.dataset.matchId = match.id;
        card.append(element('h5', match.displayId));
        match.slots.forEach(slot => {
          const name = slot.isBye ? 'BYE (부전승)' : slot.teamId ? teamNames.get(slot.teamId) : `${matches.get(slot.sourceMatchId)?.displayId ?? '이전 경기'} 승자 대기`;
          card.append(element('p', name));
        });
        const state = resultState(match);
        const labels = { PENDING: 'PENDING · 결과 대기', AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION · 상대 확인 대기', DISPUTED: 'DISPUTED · 결과 불일치 — 자동 진출 중지', CONFIRMED: 'CONFIRMED · 양 팀 일치·결과 확정', BYE: '부전승 자동 진출 · 경기 승리 아님' };
        card.append(element('p', labels[state], `badge result-state ${state.toLowerCase()}`));
        if (state !== 'BYE') {
          card.append(element('p', matchFormatLabel(item, match), 'muted'));
          for (const slot of match.slots) {
            const submission = match.submissions?.find(value => value.teamId === slot.teamId);
            card.append(element('p', `${teamNames.get(slot.teamId) ?? '진출팀 미정'}: ${submission ? `제출 완료 · 승자 ${teamNames.get(submission.winnerTeamId)} · ${submission.score.join(':')}` : '미제출'}`, 'submission-info'));
          }
          if (state === 'CONFIRMED') card.append(element('p', `확정 승자: ${teamNames.get(match.winnerTeamId)} · 점수 ${match.score.join(':')}`, 'confirmed-winner'));
          else if (match.slots.every(slot => slot.teamId) && match.slots.some(slot => item.permissions.teamIds.includes(slot.teamId))) card.append(resultForm(item, match, teamNames));
          else card.append(element('p', match.slots.every(slot => slot.teamId) ? '결과 제출은 해당 팀 대표자 로그인 후 가능합니다.' : '양 팀이 결정된 후 결과를 제출할 수 있습니다.', 'muted'));
        }
        if (match.nextMatchId) card.append(element('p', `→ ${matches.get(match.nextMatchId).displayId}의 ${match.nextSlotIndex + 1}번 자리`, 'muted'));
        card.append(matchScheduling(item, match, teamNames));
        column.append(card);
      }
      grid.append(column);
    }
    section.append(grid);
  }
  $('detail-content').append(section);
}
function resultForm(item, match, names) {
  const form = document.createElement('form'); form.className = 'result-form'; form.dataset.matchId = match.id;
  const team = document.createElement('select'); team.name = 'teamId'; team.id = `submitter-${match.id}`; team.required = true;
  const winner = document.createElement('select'); winner.name = 'winnerTeamId'; winner.id = `winner-${match.id}`; winner.required = true;
  for (const select of [team, winner]) { const placeholder = element('option', '선택해 주세요'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; select.append(placeholder); }
  for (const slot of match.slots) for (const select of [team, winner]) { if (select === team && !item.permissions.teamIds.includes(slot.teamId)) continue; const option = element('option', names.get(slot.teamId)); option.value = slot.teamId; select.append(option); }
  team.value = match.slots.find(slot => item.permissions.teamIds.includes(slot.teamId)).teamId;
  const teamLabel = element('label', '결과 제출 팀 (로그인한 대표자)'); teamLabel.htmlFor = team.id;
  const winnerLabel = element('label', '이 경기 승리 팀'); winnerLabel.htmlFor = winner.id;
  form.append(teamLabel, team, winnerLabel, winner);
  if (matchFormat(item, match) === 'Bo3') {
    const loser = document.createElement('select'); loser.name = 'loserWins'; loser.id = `loser-${match.id}`;
    for (const value of [0, 1]) { const option = element('option', `패배 팀 ${value}승 (승리 팀 2승)`); option.value = value; loser.append(option); }
    const label = element('label', 'Bo3 세트 점수'); label.htmlFor = loser.id; form.append(label, loser);
  } else form.append(element('p', 'Bo1 · 선택한 승리 팀 1승, 상대 팀 0승', 'muted'));
  const button = element('button', '결과 제출 / 수정'); button.type = 'submit';
  form.append(element('p', '확정 전 수정 가능 · 양쪽 승자와 점수가 같을 때만 확정', 'muted'), button);
  return form;
}
$('detail-content').addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('.schedule-rules-form, .schedule-proposal-form, .schedule-consent-form')) return;
  event.preventDefault(); const id = selectedId(); const item = tournaments.find(item => item.id === id); const button = event.submitter; button.disabled = true;
  try {
    if (form.matches('.schedule-rules-form')) await api(`/api/tournaments/${id}/schedule-rules`, readRules(form, item.capacity));
    else if (form.matches('.schedule-proposal-form')) {
      const values = new FormData(form); const selected = values.get('proposer');
      const proposer = selected === 'organizer' ? { role: 'organizer', name: currentUser.displayName } : { role: 'team', teamId: selected };
      await api(`/api/tournaments/${id}/matches/${form.dataset.matchId}/schedule-proposals`, { proposer, startsAt: new Date(values.get('startsAt')).toISOString() });
    } else await api(`/api/tournaments/${id}/matches/${form.dataset.matchId}/schedule-proposals/${form.dataset.proposalId}/${button.value}`, { teamId: new FormData(form).get('teamId') });
    $('message').textContent = '일정 요청을 저장했습니다. 양 팀 동의 후 규칙 검증에 성공해야 공식 확정됩니다.';
    await route();
  } catch (error) { $('message').textContent = error.message; await route(); }
});
$('detail-content').addEventListener('submit', async event => {
  const form = event.target.closest('.result-form'); if (!form) return; event.preventDefault();
  const id = selectedId(); const item = tournaments.find(item => item.id === id);
  const match = item.bracket.rounds.flatMap(round => round.matches).find(match => match.id === form.dataset.matchId);
  const values = new FormData(form); const winnerId = values.get('winnerTeamId');
  const score = match.slots.map(slot => slot.teamId === winnerId ? (matchFormat(item, match) === 'Bo3' ? 2 : 1) : Number(values.get('loserWins') ?? 0));
  const button = form.querySelector('button'); button.disabled = true;
  try {
    await api(`/api/tournaments/${id}/matches/${match.id}/results`, { teamId: values.get('teamId'), winnerTeamId: winnerId, score });
    $('message').textContent = '결과를 저장했습니다. 양 팀이 일치하면 자동 확정됩니다.';
    await route();
  } catch (error) { $('message').textContent = error.message; button.disabled = false; }
});
function confirmRecruitClose(item) {
  const dialog = $('recruit-close-dialog'), cancelling = canCancelUnderfilled(item);
  $('recruit-close-title').textContent = cancelling ? '모집 인원 미달 · 대회 취소 확인' : '모집 종료 확인';
  $('recruit-close-message').textContent = cancelling
    ? `현재 승인된 ${approvedTeamCount(item)}팀이 참가했습니다. 최소 개최 조건인 2팀을 충족하지 못했습니다. 모집을 종료하면 대회가 취소됩니다. 참가팀과 대표자 기록은 삭제하지 않습니다.`
    : `현재 ${item.teams.length}팀이 참가했습니다. 모집을 종료하면 추가 참가 신청을 받지 않습니다. 대진표는 자동 생성되지 않으며 다음 단계에서 별도로 생성합니다.`;
  $('recruit-close-confirm').textContent = cancelling ? '대회 취소 확정' : '모집 종료 확정';
  dialog.returnValue = ''; dialog.showModal(); $('recruit-close-cancel').focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
window.addEventListener('hashchange', () => { if ($('recruit-close-dialog').open) $('recruit-close-dialog').close('cancel'); });
$('detail-content').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const id = selectedId(); button.disabled = true;
  try {
    if (button.dataset.action === 'close' && (!(await confirmRecruitClose(tournaments.find(item => item.id === id))) || selectedId() !== id)) { button.disabled = false; if (button.isConnected) button.focus({ preventScroll: true }); return; }
    const result = await api(`/api/tournaments/${id}/${button.dataset.action}`, {});
    $('message').textContent = result.status === 'CANCELLED' ? '모집 인원 미달로 대회가 취소되었습니다. 참가팀과 대표자 기록은 보존됩니다.' : button.dataset.action === 'close' ? '참가 모집을 마감했습니다. 등록된 팀은 모두 보존됩니다.' : '대진표를 생성했습니다. 재추첨할 수 없습니다.';
    await route();
  } catch (error) { $('message').textContent = error.message; await route(); }
});
async function route() {
  const version = ++routeVersion;
  const create = location.hash === '#create'; const id = selectedId(); const guide = location.hash === '#guide';
  if (location.hash === '#friendly' || location.hash === '#competitive') filters.type = location.hash.slice(1);
  else if (location.hash === '#list' || !location.hash) filters.type = 'all';
  if (create && !currentUser) { history.replaceState(null, '', '#list'); requestLogin({ type: 'create' }, $('login-open')); return route(); }
  $('list-view').hidden = create || Boolean(id) || guide; $('create-view').hidden = !create; $('detail-view').hidden = !id; $('guide-view').hidden = !guide;
  $('home-intro').hidden = create || Boolean(id) || guide; $('workspace-nav').hidden = !create && !id;
  $('list-tab').setAttribute('aria-current', !create ? 'page' : 'false');
  $('create-tab').setAttribute('aria-current', create ? 'page' : 'false'); $('date').min = kstDate(Date.now());
  $('team-error').textContent = ''; $('team-form').reset();
  if (id) { $('team-form').hidden = true; $('detail-view').append($('join-button'), $('team-form')); $('detail-content').replaceChildren(element('p', '불러오는 중…')); }
  try {
    const result = await api(); if (version !== routeVersion) return;
    tournaments = result; render(); if (id) showDetail(tournaments.find(item => item.id === id));
  } catch (error) { if (version === routeVersion) $('message').textContent = error.message; }
}
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = { name: $('name').value.trim(), date: $('date').value, capacity: Number($('capacity').value), description: $('description').value.trim(), kind: $('kind').value, earlyCloseMinTeams: $('early-close').value ? Number($('early-close').value) : null, finalFormat: $('final-format').value };
  data.competitionType = data.kind === 'friendly' ? 'friendly' : 'competitive'; data.participationScope = $('participation-scope').value;
  if ($('enable-scheduling').checked) { try { data.scheduling = readRules($('create-form'), data.capacity, true); } catch (error) { $('form-error').textContent = error.message; return; } }
  try { data.startsAt = kstInputToIso(`${$('date').value}T${$('start-time').value}`); data.recruitEndAt = kstInputToIso($('recruit-end').value); }
  catch (error) { $('form-error').textContent = error.message; return; }
  const error = validateTournament(data, kstDate(Date.now())); $('form-error').textContent = error; if (error) return;
  const button = event.submitter; button.disabled = true;
  try {
    await api('/api/tournaments', data); $('create-form').reset();
    $('message').textContent = `“${data.name}” 대회를 생성했습니다.`; location.hash = '#list';
  } catch (error) { $('form-error').textContent = error.message; }
  finally { button.disabled = false; }
});
function createRuleInputs() {
  const fields = rulesFields(Number($('capacity').value), true);
  fields.querySelectorAll('input').forEach(input => { input.disabled = !$('enable-scheduling').checked; });
  $('creation-scheduling').replaceChildren(fields);
}
$('capacity').addEventListener('change', createRuleInputs);
$('enable-scheduling').addEventListener('change', () => $('creation-scheduling').querySelectorAll('input').forEach(input => { input.disabled = !$('enable-scheduling').checked; }));
$('create-form').addEventListener('reset', () => { queueMicrotask(createRuleInputs); });
createRuleInputs();
for (let index = 0; index < 5; index++) {
  const label = element('label', `팀원 ${index + 1} Riot ID`); label.htmlFor = `member-${index}`;
  const input = document.createElement('input'); input.id = label.htmlFor; input.required = true; input.maxLength = 50; input.placeholder = '게임이름#KR1';
  $('member-inputs').append(label, input);
}
$('team-form').addEventListener('submit', async event => {
  event.preventDefault(); const id = selectedId();
  const data = { name: $('team-name').value.trim(), representativeName: $('representative-name').value.trim(), members: Array.from({ length: 5 }, (_, index) => $(`member-${index}`).value.trim()), representativeIndex: Number($('representative').value) };
  const error = validateTeam(data); $('team-error').textContent = error; if (error) return;
  const button = event.submitter; button.disabled = true;
  try {
    await api(`/api/tournaments/${id}/teams`, data);
    $('message').textContent = '팀 참가가 자동 승인되었으며 로그인 계정이 대표자로 연결되었습니다.'; await route();
  } catch (error) {
    const message = error.message;
    try { tournaments = await api(); if (selectedId() === id) { render(); showDetail(tournaments.find(item => item.id === id)); } } catch { /* 입력은 유지합니다. */ }
    $('team-error').textContent = message;
  } finally { button.disabled = false; }
});
window.addEventListener('hashchange', route);
$('refresh-data').addEventListener('click', async () => { try { await refreshSession(); await route(); } catch (error) { $('message').textContent = error.message; } });
$('detail-refresh').addEventListener('click', async () => { try { await refreshSession(); await route(); } catch (error) { $('message').textContent = error.message; } });
try { await refreshSession(); await route(); } catch (error) { $('auth-error').textContent = `서버 연결 실패: ${error.message}`; }

