import { finalFormatLabel, displayKst, deadlinePassed } from './model.js';
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
export function detailLayout(item,joinButton) {
 const root=el('div','','tournament-detail');root.dataset.tournamentId=item.id;
 const banner=el('header','','event-banner');banner.append(el('p','KNU ARENA · LEAGUE OF LEGENDS','event-kicker'),el('h2',item.name),el('p',`${typeLabel(item)} · ${scopeLabel(item)} · ${tournamentStage(item).label}`,'event-status'));
 const facts=el('dl','','event-facts');
 if(item.rewardPolicy && item.status!=='CANCELLED') banner.append(el('p',`이 대회 우승팀 대표자에게 시연용 ${item.rewardPolicy.win_amount}P가 지급됩니다. 현금·기프티콘 교환은 지원하지 않습니다.`,'notice champion-reward-notice'));
 const values=[['개최자',item.permissions.legacyReadOnly?'기존 데모 · 개최자 미연결':'개최자 계정 연결됨 · 공개 이름 미제공'],['참가 현황',`${item.teams.length} / ${item.capacity}팀`],['모집 기간','별도 기간 미저장 · 현재 모집 상태 확인'],['모집 상태',item.status==='open'?'모집 열림 (정원·참가 조건 적용)':'모집 마감'],['경기 예정일',item.date || '미설정'],['경기 기간',item.scheduling?`${time(item.scheduling.startsAt)} ~ ${time(item.scheduling.endsAt)}`:'상세 기간 미설정'],['경기 방식',`LoL 5인 팀 · 싱글 엘리미네이션 · 일반 Bo1 / 결승 ${finalFormatLabel(item)}`]];
 if(item.recruitEndAt) values.splice(2,1,['모집 마감 일시',displayKst(item.recruitEndAt)]);
 if(item.startsAt) values.push(['대회 시작 시각',displayKst(item.startsAt)]);
 if(deadlinePassed(item)) values[3][1]='모집 마감';
 if(item.status==='CANCELLED') values[3][1]='취소됨';
 for(const [k,v]of values){const pair=el('div');pair.append(el('dt',k),el('dd',v));facts.append(pair);}banner.append(facts);
 const actions=el('div','','event-actions');const rules=el('button','대회 규정','button-outline');rules.type='button';rules.dataset.detailTarget='event-rules';actions.append(joinButton,rules);banner.append(actions);root.append(banner);
 if(item.status==='CANCELLED') banner.append(el('p',`취소됨 · ${item.cancelReason || '모집 인원 미달'} · 취소 시각 ${displayKst(item.cancelledAt)} · 기존 참가팀 기록은 보존됩니다.`,'notice cancellation-notice'));
 const nav=el('nav','','event-nav');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','대회 상세 메뉴');
 const sections={};
 for(const[id,label]of [['home','대회 홈'],['notices','공지사항'],['bracket','대진/일정'],['participants','참가자'],['videos','영상'],['questions','문의게시판'],['rules','대회규정']]){
  const b=el('button',label);b.type='button';b.dataset.detailTarget='event-'+id;b.setAttribute('role','tab');b.setAttribute('aria-controls','event-'+id);b.id='tab-event-'+id;if(id==='home')b.setAttribute('aria-current','location');nav.append(b);
  const section=el('section','','event-section');section.id='event-'+id;section.dataset.detailSection='';section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby',b.id);const heading=el('h3',label);heading.tabIndex=-1;section.append(heading);sections[id]=section;
 }root.append(nav,...Object.values(sections));
 sections.home.append(el('h4','대회 소개'),el('p',item.description || '등록된 소개가 없습니다.'),el('h4','참가 조건'),el('p','LoL 5인 팀 · 대표자 계정으로 신청 · 정원 내 유효한 신청 자동 승인. 학교 이메일·Riot 계정 소유권과 학과 소속은 아직 검증하지 않습니다.'),el('p',`${scopeLabel(item)} · ${item.teams.length}/${item.capacity}팀 · ${item.bracket?'대진표 생성 완료 · 재추첨 불가':'대진표 미생성'}`));
 sections.home.append(el('h4','모집 및 운영 일정'),el('p',item.recruitEndAt?`모집 마감: ${displayKst(item.recruitEndAt)} · 대회 시작: ${displayKst(item.startsAt)}`:`경기 예정일: ${item.date || '미설정'} · 모집 시작/종료 일시는 별도 저장되지 않습니다.`),el('p',item.scheduling?`경기 기간: ${time(item.scheduling.startsAt)} ~ ${time(item.scheduling.endsAt)}`:'상세 운영 종료·라운드 기간은 아직 설정되지 않았습니다.'));
 const matches=item.bracket?.rounds.flatMap(r=>r.matches)??[];const scheduled=matches.filter(m=>m.schedule).sort((a,b)=>new Date(b.schedule.confirmedAt??b.schedule.startsAt)-new Date(a.schedule.confirmedAt??a.schedule.startsAt));
 sections.home.append(el('h4','현재 확정 경기 일정'));
 if(!scheduled.length)sections.home.append(el('p','아직 확정된 경기 일정이 없습니다.','muted'));
 for(const match of scheduled.slice(0,3))sections.home.append(el('p',`${match.displayId} · ${time(match.schedule.startsAt)} ~ ${time(match.schedule.endsAt)}`));
 sections.home.append(el('p','전체 라운드 기간과 일정 제안·동의는 대진/일정에서 확인하세요.','muted'));
 for(const[id,text]of [['notices','공지사항 기능은 준비 중입니다. 등록된 공지 데이터가 없습니다.'],['videos','영상 업로드·재생 기능은 제공하지 않습니다.'],['questions','문의게시판은 준비 중입니다. 게시글 작성·댓글 기능은 제공하지 않습니다.']])sections[id].append(el('p',text,'notice'));
 if(item.status==='CANCELLED') sections.participants.append(el('p','취소된 대회의 참가팀 기록입니다. 참가팀과 대표자 연결을 보존하며 변경할 수 없습니다.','notice'));
 sections.rules.append(rulesPanel());return{root,...sections};
}
