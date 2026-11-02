/* Shared navigation and accessible UI chrome; no learning data migrations. */
const UI_ICONS={
 map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Z"/><path d="M9 3v16M15 5v16"/>',
 random:'<path d="M3 6h3c4 0 8 12 12 12h3M3 18h3c1 0 3-2 5-5M14 7c2-1 3-1 4-1h3"/><path d="m18 3 3 3-3 3m0 6 3 3-3 3"/>',
 wrong:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
 favorites:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
 practice:'<path d="m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18"/>',
 coach:'<path d="M21 15a3 3 0 0 1-3 3H9l-6 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z"/>',
 library:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
 progress:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
 more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 back:'<path d="m14 5-7 7 7 7"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>'
};
function uiIcon(name){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name]||UI_ICONS.more}</svg>`;}
function openMoreNavigation(){const d=document.querySelector('#more-dialog');if(d&&!d.open){d.showModal();document.querySelector('.nav-more')?.setAttribute('aria-expanded','true');}}
function closeMoreNavigation(){document.querySelector('#more-dialog')?.close();document.querySelector('.nav-more')?.setAttribute('aria-expanded','false');}
function refreshAppChrome(){
 document.body.dataset.view=view;
 const count=document.querySelector('#wrong-count');if(count)count.hidden=state.wrong.length===0;
 for(const link of document.querySelectorAll('#navigation a')){
  const icon=link.querySelector('span');if(icon)icon.innerHTML=uiIcon(link.dataset.view);
  if(link.classList.contains('active'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
 }
 const more=document.querySelector('.nav-more');if(more){more.classList.toggle('active',!['map','wrong','coach','teach'].includes(view));more.querySelector('span').innerHTML=uiIcon('more');}
 for(const el of document.querySelectorAll('[data-ui-icon]'))el.innerHTML=uiIcon(el.dataset.uiIcon);
 for(const el of document.querySelectorAll('.option.correct,.option.incorrect'))if(!el.querySelector('.answer-state')){const correct=el.classList.contains('correct');el.insertAdjacentHTML('beforeend',`<span class="answer-state" aria-label="${correct?'正确答案':'本次选错'}">${uiIcon(correct?'check':'close')}</span>`);}
}
const renderBeforeUI=render;render=function(){renderBeforeUI();refreshAppChrome();};
const renderQuizBeforeUI=renderQuiz;renderQuiz=function(){renderQuizBeforeUI();refreshAppChrome();};
window.addEventListener('hashchange',closeMoreNavigation);
document.querySelector('#more-dialog')?.addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeMoreNavigation();}});
document.querySelector('#more-dialog')?.addEventListener('close',()=>document.querySelector('.nav-more')?.setAttribute('aria-expanded','false'));
refreshAppChrome();
