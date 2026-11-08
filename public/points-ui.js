import { displayKst } from './model.js';
const $ = id => document.getElementById(id);
let version = 0;
const names = { SIGNUP_BONUS: '회원가입 보너스', TOURNAMENT_WIN: '대회 우승 보상', CREDIT: '포인트 적립', DEBIT: '포인트 차감', PARTICIPATION_REWARD: '참가 보상' };
const node = (tag, text, cls = '') => { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; };
export function resetPoints(guest = false) {
  version++;
  $('points-transactions').replaceChildren(); $('points-balance').textContent = '—';
  for (const id of ['points-data','points-loading','points-error','points-retry','points-more','points-empty']) $(id).hidden = true;
  $('points-guest').hidden = !guest; $('points-error').textContent = '';
}
export async function showPoints(user, api) {
  resetPoints(!user); if (!user) return;
  const current = version, seen = new Set(); let offset = 0;
  const active = () => current === version && location.hash === '#points';
  function append(rows) {
    for (const tx of rows) {
      if (seen.has(tx.id)) continue; seen.add(tx.id);
      const row = node('li', '', 'point-transaction'), heading = node('div', '', 'point-transaction-heading');
      heading.append(node('h4', names[tx.type] || '포인트 거래'), node('strong', `${tx.delta > 0 ? '+' : '−'}${Math.abs(tx.delta).toLocaleString('ko-KR')} P`, 'point-delta'));
      const time = node('time', displayKst(tx.created_at)); time.dateTime = tx.created_at;
      row.append(heading, node('p', tx.reason), time, node('p', `거래 후 잔액 ${tx.balance_after.toLocaleString('ko-KR')} P`, 'muted'));
      if (tx.tournamentExists) { const link = node('a', '관련 대회 보기'); link.href = '#detail/' + encodeURIComponent(tx.tournament_id); row.append(link); }
      $('points-transactions').append(row);
    }
  }
  async function load(more = false) {
    $('points-loading').hidden = false; $('points-more').hidden = true; $('points-error').hidden = true; $('points-retry').hidden = true;
    try {
      const [balance, page] = await Promise.all([more ? Promise.resolve(null) : api('/api/me/points'), api(`/api/me/point-transactions?limit=20&offset=${offset}`)]);
      if (!active()) return;
      if (balance) $('points-balance').textContent = `${balance.balance.toLocaleString('ko-KR')} P`;
      append(page.transactions); offset = page.nextOffset;
      $('points-data').hidden = false; $('points-empty').hidden = seen.size !== 0; $('points-more').hidden = !page.hasMore;
      $('points-more').onclick = () => load(true);
    } catch (error) {
      if (!active()) return;
      if (!more) { $('points-data').hidden = true; $('points-balance').textContent = '—'; }
      $('points-error').textContent = `포인트 조회에 실패했습니다. ${error.message}`; $('points-error').hidden = false; $('points-retry').hidden = false;
      $('points-retry').onclick = () => load(more);
    } finally { if (active()) $('points-loading').hidden = true; }
  }
  await load();
}
