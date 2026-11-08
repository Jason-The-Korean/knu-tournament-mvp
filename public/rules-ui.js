const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
export function rulesPanel(){
 const root=el('div','','rules-pdf-panel');root.append(el('p','공통 운영 규정 PDF를 확인하는 중…','muted'));
 fetch('/api/rules').then(async response=>{if(!response.ok)throw new Error('규정 정보를 불러오지 못했습니다.');return response.json();}).then(data=>{
  root.replaceChildren();
  if(!data.available){root.append(el('p','운영 규정 PDF가 준비되지 않았습니다. 파일 준비 후 다시 확인해 주세요.','notice'));return;}
  root.append(el('h4',data.title),el('p','임시/초안 · v0.2 · 학교 공식 규정이 아닙니다. 문서의 계획·검토 항목은 현재 구현된 기능이나 확정 정책을 의미하지 않습니다.','notice'));
  const actions=el('div','','pdf-actions');const preview=el('button','PDF 미리보기','button-outline');preview.type='button';
  const open=el('a','새 탭에서 열기','button button-outline');open.href=data.url;open.target='_blank';open.rel='noopener';
  const download=el('a','PDF 다운로드','button button-outline');download.href=data.url+'?download=1';download.download='knu-arena-rules-draft-v0.2.pdf';actions.append(preview,open,download);root.append(actions,el('p','미리보기가 지원되지 않거나 비어 보이면 새 탭 또는 다운로드로 확인하세요. PDF 자체의 페이지 색상은 테마와 관계없이 원본을 유지합니다.','muted'));
  preview.addEventListener('click',()=>{const existing=root.querySelector('iframe');if(existing){existing.remove();preview.textContent='PDF 미리보기';return;}const frame=document.createElement('iframe');frame.title='공통 임시 운영 규정 PDF 미리보기';frame.src=data.url;frame.className='rules-pdf-frame';root.append(frame);preview.textContent='미리보기 닫기';});
 }).catch(error=>{root.replaceChildren(el('p',`${error.message} 새로고침 후 다시 시도해 주세요.`,'notice'));});
 return root;
}
