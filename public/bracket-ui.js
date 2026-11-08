import { resultState, matchFormatLabel, finalFormatLabel } from './model.js';
const stateById=new Map();
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
const labels={PENDING:'결과 대기',AWAITING_CONFIRMATION:'상대 확인 대기',DISPUTED:'결과 불일치',CONFIRMED:'결과 확정',BYE:'BYE · 부전승'};
function modal(title,body,onClose=()=>{}){
 const dialog=el('dialog','','bracket-dialog');const close=el('button','닫기','button-outline');close.type='button';const heading=el('h3',title);heading.id='bracket-dialog-title';dialog.setAttribute('aria-labelledby',heading.id);dialog.append(heading,close,body);document.getElementById('detail-content').append(dialog);const trigger=document.activeElement;close.onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});dialog.addEventListener('close',()=>{onClose();dialog.remove();if(trigger?.isConnected)trigger.focus({preventScroll:true});},{once:true});dialog.showModal();close.focus();return dialog;
}
export function teamButton(item,team){const b=el('button',team.name,'team-detail-button');b.type='button';b.dataset.teamId=team.id;b.onclick=()=>{
 const body=el('div');body.append(el('p',`참가 대회: ${item.name}`),el('p',team.representativeName?`대표자: ${team.representativeName}`:'대표자: 공개되지 않음'),el('p','5인 팀 · 참가 승인 완료'));
 if(team.members?.length){const list=el('ol');team.members.forEach((id,i)=>list.append(el('li',`${id}${i===team.representativeIndex?' (대표자)':''}`)));body.append(list);}else body.append(el('p','선수 5명의 Riot ID와 대표자 정보는 개최자와 해당 팀 대표자에게만 공개됩니다.','notice'));
 body.append(el('p','학교 이메일·Riot 계정 소유권 인증은 제공하지 않습니다.','muted'),el('h4','이 대회의 경기 기록'));
 const records=item.bracket?.rounds.flatMap(r=>r.matches.map(m=>({round:r.label,match:m}))).filter(({match})=>match.slots.some(s=>s.teamId===team.id))??[];
 for(const {round,match}of records){const names=match.slots.map(s=>s.isBye?'BYE':item.teams.find(t=>t.id===s.teamId)?.name??'미정');body.append(el('p',`${round} ${match.displayId} · ${names.join(' vs ')} · ${labels[resultState(match)]}${match.score?' · '+match.score.join(':'):''}${match.winnerTeamId===team.id?(match.countsAsPlayed?' · 승리':' · 부전승 진출 (승리 통계 제외)'):''}`));}
 if(!records.length)body.append(el('p','아직 배정된 경기가 없습니다.'));modal(team.name,body);
 };return b;}
export function enhanceBracket(item,host){
 const state=stateById.get(item.id)??{tab:'tree',zoom:1,x:0,y:0};stateById.set(item.id,state);
 const legacy=host.querySelector('.bracket-section');if(!item.bracket)return;
 const rounds=item.bracket.rounds,matches=rounds.flatMap(r=>r.matches),names=new Map(item.teams.map(t=>[t.id,t.name]));
 const tabs=el('div','','bracket-subtabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','대진 및 일정 보기');const tree=el('div','','bracket-tree-panel'),schedule=el('div','','bracket-schedule-panel');tree.id='bracket-tree';schedule.id='bracket-schedule';tree.setAttribute('role','tabpanel');schedule.setAttribute('role','tabpanel');
 for(const[id,text,panel]of [['tree','대진표',tree],['schedule','경기 일정',schedule]]){const b=el('button',text);b.type='button';b.dataset.bracketTab=id;b.id='bracket-tab-'+id;b.setAttribute('role','tab');b.setAttribute('aria-controls',panel.id);panel.setAttribute('aria-labelledby',b.id);b.onclick=()=>{state.tab=id;syncTabs();};b.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const other=tabs.querySelector(`[data-bracket-tab=${id==='tree'?'schedule':'tree'}]`);other.click();other.focus();}};tabs.append(b);}
 function syncTabs(){tree.hidden=state.tab!=='tree';schedule.hidden=state.tab!=='schedule';tabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.bracketTab===state.tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});}
 const tools=el('div','','bracket-tools');tools.append(el('p',`${item.bracket.teamCount}팀 · 싱글 엘리미네이션 · 일반 Bo1 / 결승 ${finalFormatLabel(item)}`));const zoomLabel=el('output','100%');zoomLabel.setAttribute('aria-live','polite');
 const viewport=el('div','','bracket-viewport');viewport.tabIndex=0;viewport.setAttribute('aria-label','대진표 가로 스크롤 영역');const surface=el('div','','bracket-surface'),canvas=el('div','','bracket-canvas');surface.append(canvas);viewport.append(surface);
 const positions=new Map();rounds.forEach((round,ri)=>round.matches.forEach((match,mi)=>{const incoming=matches.filter(m=>m.nextMatchId===match.id).map(m=>positions.get(m.id)?.y).filter(v=>v!==undefined);positions.set(match.id,{x:ri*320+12,y:incoming.length?incoming.reduce((a,b)=>a+b,0)/incoming.length:mi*210+70,round});}));
 const width=rounds.length*320, height=Math.max(300,rounds[0].matches.length*210+80);canvas.style.width=width+'px';canvas.style.height=height+'px';
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('bracket-connectors');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('aria-hidden','true');canvas.append(svg);
 const store=el('div');store.hidden=true;const legacyCards=new Map([...legacy.querySelectorAll('.match-card')].map(card=>[card.dataset.matchId,card]));
 const scheduleHomes=new Map();
 function openMatch(match){const card=legacyCards.get(match.id);if(!card)return;const scheduleSection=scheduleHomes.get(match.id)?.querySelector('.match-scheduling');if(scheduleSection)card.append(scheduleSection);const body=el('div');body.append(el('p',`${positions.get(match.id).round.label} · ${matchFormatLabel(item,match)}`),card);modal('경기 상세 · '+match.displayId,body,()=>{const scheduling=card.querySelector('.match-scheduling');if(scheduling)scheduleHomes.get(match.id).append(scheduling);store.append(card);});}
 for(const round of rounds){const ri=rounds.indexOf(round);const label=el('h4',`${round.label} · ${round.matches.length}경기`,'tree-round-label');label.style.left=(ri*320+12)+'px';canvas.append(label);
  for(const match of round.matches){const p=positions.get(match.id),node=el('article','','bracket-node');node.dataset.matchId=match.id;node.style.left=p.x+'px';node.style.top=p.y+'px';const stateLabel=labels[resultState(match)];node.append(el('p',`${match.displayId} · ${stateLabel} · ${matchFormatLabel(item,match)}`,'node-state'));
   for(const slot of match.slots){const team=item.teams.find(t=>t.id===slot.teamId);const row=team?teamButton(item,team):el('p',slot.isBye?'BYE · 부전승':'미정','tree-slot-empty');row.classList.add('tree-slot');if(slot.teamId&&slot.teamId===match.winnerTeamId){row.classList.add('tree-winner');row.append(el('span',match.countsAsPlayed?'승':'진출'));}node.append(row);}
   const detail=el('button','경기 상세','match-open');detail.type='button';detail.dataset.openMatch=match.id;detail.onclick=()=>openMatch(match);node.append(detail);canvas.append(node);
   if(match.nextMatchId&&positions.has(match.nextMatchId)){const next=positions.get(match.nextMatchId),line=document.createElementNS(svg.namespaceURI,'path');line.dataset.fromMatch=match.id;line.dataset.toMatch=match.nextMatchId;line.dataset.toSlot=match.nextSlotIndex;line.setAttribute('d',`M${p.x+264},${p.y+82} H${p.x+290} V${next.y+56+match.nextSlotIndex*36} H${next.x}`);svg.append(line);}
   const card=legacyCards.get(match.id),entry=el('article','','schedule-entry');entry.dataset.matchId=match.id;entry.append(el('h4',`${round.label} · ${match.displayId}`),el('p',match.slots.map(s=>s.isBye?'BYE':names.get(s.teamId)??'미정').join(' vs ')));const button=el('button','경기 정보·결과 보기','button-outline');button.type='button';button.onclick=()=>openMatch(match);entry.append(button);const scheduling=card?.querySelector('.match-scheduling');if(scheduling)entry.append(scheduling);scheduleHomes.set(match.id,entry);schedule.append(entry);if(card)store.append(card);
  }
 }
 const champions=[...legacy.querySelectorAll('.champion')];legacy.replaceChildren(...champions,store);legacy.classList.add('bracket-enhanced');
 const config=host.querySelector('.schedule-configuration');if(config)schedule.prepend(config);
 tree.append(tools,el('p','팀 이름을 선택하면 공개 가능한 팀 정보를 확인합니다. 미정 슬롯은 이전 경기 확정을 기다립니다.','muted'),viewport);
 function scale(){canvas.style.transform=`scale(${state.zoom})`;surface.style.width=width*state.zoom+'px';surface.style.height=height*state.zoom+'px';zoomLabel.textContent=Math.round(state.zoom*100)+'%';}
 for(const[text,delta]of [['축소',-.1],['확대',.1],['기본 배율',0]]){const b=el('button',text,'button-outline');b.type='button';b.dataset.zoom=text==='축소'?'out':text==='확대'?'in':'reset';b.onclick=()=>{state.zoom=delta?Math.max(.6,Math.min(1.6,Math.round((state.zoom+delta)*10)/10)):1;scale();};tools.append(b);}tools.append(zoomLabel);scale();
 viewport.addEventListener('scroll',()=>{state.x=viewport.scrollLeft;state.y=viewport.scrollTop;},{passive:true});
 host.append(tabs,tree,schedule);syncTabs();requestAnimationFrame(()=>{viewport.scrollLeft=state.x;viewport.scrollTop=state.y;});
}
