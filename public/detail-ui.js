import { finalFormatLabel, displayKst, deadlinePassed, registrationReason } from './model.js';
import { tournamentStage, typeLabel, scopeLabel } from './arena.js';
import { rulesPanel } from './rules-ui.js';
const tabs = new Map();
export function activateDetailTab(id, focus = false) {
 const root=document.querySelector('.tournament-detail');if(!root)return;
 tabs.set(root.dataset.tournamentId,id);
 for(const section of root.querySelectorAll('[data-detail-section]'))section.hidden=section.id!==id;
 for(const button of root.querySelectorAll('.event-nav button')){const active=button.dataset.detailTarget===id;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
 if(focus){const section=document.getElementById(id);section.scrollIntoView({block:'start'});section.querySelector('h3')?.focus({preventScroll:true});}
 root.dispatchEvent(new Event('detail-tab-change'));
}
export function restoreDetailTab(item){activateDetailTab(tabs.get(item.id)||'event-home');}
document.addEventListener('click',event=>{const b=event.target.closest('[data-detail-target]');if(b)activateDetailTab(b.dataset.detailTarget,true);});
document.addEventListener('keydown',event=>{const b=event.target.closest('.event-nav [role=tab]');if(!b||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...b.parentElement.children],i=buttons.indexOf(b),next=event.key==='Home'?buttons[0]:event.key==='End'?buttons.at(-1):buttons[(i+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length];activateDetailTab(next.dataset.detailTarget);next.focus();next.scrollIntoView({block:'nearest',inline:'nearest'});});
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
export const time=value=>value ? new Date(value).toLocaleString('ko-KR') : '미설정';
export function recruitmentLabel(item) {
 if(item.status==='CANCELLED')return '취소됨';
 if(item.permissions.legacyReadOnly)return '기록 열람';
 if(item.status!=='open'||item.bracket||deadlinePassed(item))return '모집 마감';
 if(item.teams.length>=item.capacity)return '정원 충족';
 return registrationReason(item)?'모집 마감':'모집 중';
}
export function detailLayout(item,joinButton) {
 const root=el('div','','tournament-detail');root.dataset.tournamentId=item.id;
 const banner=el('header','','event-banner');banner.append(el('p','KNU ARENA · LEAGUE OF LEGENDS','event-kicker'),el('h2',item.name),el('p',`${typeLabel(item)} · ${scopeLabel(item)} · ${tournamentStage(item).label}`,'event-status'));
 const facts=el('dl','','event-facts');
 if(item.rewardPolicy && item.status!=='CANCELLED') banner.append(el('p',`우승팀 대표자 +${item.rewardPolicy.win_amount}P · 시연용 포인트이며 현금·상품으로 교환할 수 없습니다.`,'notice champion-reward-notice'));
 const values=[['참가 현황',`${item.teams.length} / ${item.capacity}팀`],['모집 상태',recruitmentLabel(item)],['모집 마감',item.recruitEndAt?displayKst(item.recruitEndAt):'마감 일시 미정'],['대회 시작',item.startsAt?displayKst(item.startsAt):item.date||'일정 미정'],['경기 방식',`LoL 5인 팀 · 일반 Bo1 / 결승 ${finalFormatLabel(item)}`]];
 for(const [k,v]of values){const pair=el('div'),value=el('dd',v);if(k==='참가 현황')value.dataset.recruitCount='';if(k==='모집 상태')value.dataset.recruitState='';pair.append(el('dt',k),value);facts.append(pair);}banner.append(facts);
 const actions=el('div','','event-actions');actions.append(joinButton);banner.append(actions);root.append(banner);
 if(item.status==='CANCELLED') banner.append(el('p',`취소됨 · ${item.cancelReason || '모집 인원 미달'} · 취소 시각 ${displayKst(item.cancelledAt)} · 기존 참가팀 기록은 보존됩니다.`,'notice cancellation-notice'));
 const nav=el('nav','','event-nav');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','대회 상세 메뉴');
 const sections={};
 for(const[id,label]of [['home','대회 홈'],['participants','참가 팀·멤버'],['bracket','대진표·경기 일정'],['rules','대회규정'],['notices','공지사항'],['videos','영상'],['questions','문의게시판']]){
  const b=el('button',label);b.type='button';b.dataset.detailTarget='event-'+id;b.setAttribute('role','tab');b.setAttribute('aria-controls','event-'+id);b.id='tab-event-'+id;if(id==='home')b.setAttribute('aria-current','location');nav.append(b);
  const section=el('section','','event-section');section.id='event-'+id;section.dataset.detailSection='';section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby',b.id);const heading=el('h3',label);heading.tabIndex=-1;section.append(heading);sections[id]=section;
 }root.append(nav,...Object.values(sections));
 sections.home.append(el('h4','대회 소개'),el('p',item.description || '아직 대회 소개가 없습니다.'),el('h4','참가 안내'),el('p','대표자 한 명이 팀원 5명의 Riot ID를 등록합니다. 정원 내 신청은 선착순으로 승인됩니다. 학교 소속과 Riot 계정은 별도로 확인하지 않습니다.'),el('p',`${scopeLabel(item)} · ${item.teams.length}/${item.capacity}팀 · ${item.bracket?'대진표 확정 · 재추첨 불가':'대진표 준비 중'}`));
 if(item.scheduling)sections.home.append(el('h4','경기 기간'),el('p',`${time(item.scheduling.startsAt)} ~ ${time(item.scheduling.endsAt)}`));
 const matches=item.bracket?.rounds.flatMap(r=>r.matches)??[];const scheduled=matches.filter(m=>m.schedule).sort((a,b)=>new Date(b.schedule.confirmedAt??b.schedule.startsAt)-new Date(a.schedule.confirmedAt??a.schedule.startsAt));
 sections.home.append(el('h4','현재 확정 경기 일정'));
 if(!scheduled.length)sections.home.append(el('p',item.status==='CANCELLED'?'취소된 대회에는 새 일정을 정할 수 없습니다.':item.bracket?.championTeamId?'이 대회에 기록된 경기 일정이 없습니다.':!item.bracket?'대진표를 만든 뒤 양 팀이 경기 일정을 정할 수 있습니다.':!item.scheduling?'경기 시간 설정 후 양 팀이 일정을 제안하고 동의하면 표시됩니다.':'양 팀이 같은 일정에 동의하면 여기에 표시됩니다.','muted'));
 for(const match of scheduled.slice(0,3))sections.home.append(el('p',`${match.displayId} · ${time(match.schedule.startsAt)} ~ ${time(match.schedule.endsAt)}`));
 sections.home.append(el('p','‘대진표·경기 일정’ → ‘경기 일정’에서 경기별 일정과 결과를 확인하세요.','muted'));
 for(const[id,text]of [['notices','공지사항은 아직 이용할 수 없습니다. 대회 안내는 대회 홈을 확인해 주세요.'],['videos','영상은 아직 제공하지 않습니다.'],['questions','문의게시판은 아직 이용할 수 없습니다.']])sections[id].append(el('p',text,'notice'));
 if(item.status==='CANCELLED') sections.participants.append(el('p','취소된 대회의 참가팀 기록입니다. 참가팀과 대표자 연결을 보존하며 변경할 수 없습니다.','notice'));
 sections.rules.append(rulesPanel());return{root,...sections};
}
