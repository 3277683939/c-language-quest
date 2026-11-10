/* Shared navigation and accessible UI chrome; no learning data migrations. */
const UI_ICONS={
 leaderboard:'<path d="M8 3h8v5a4 4 0 0 1-8 0ZM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 12v6m-4 3h8m-6-3h4"/>',
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
function scrollActiveChapterIntoView(smooth){
 if(view!=='map'||typeof window==='undefined')return;
 const chaptersContainer=document.querySelector('.chapters');
 const activeChapter=chaptersContainer?.querySelector('.chapter.active');
 if(!chaptersContainer||!activeChapter)return;
 const style=getComputedStyle(chaptersContainer);
 if(style.flexDirection!=='row')return;
 const containerRect=chaptersContainer.getBoundingClientRect();
 const itemRect=activeChapter.getBoundingClientRect();
 const currentScroll=chaptersContainer.scrollLeft;
 const targetScroll=currentScroll+(itemRect.left-containerRect.left)-(containerRect.width/2)+(itemRect.width/2);
 const maxScroll=Math.max(0,chaptersContainer.scrollWidth-chaptersContainer.clientWidth);
 const clampedScroll=Math.max(0,Math.min(maxScroll,targetScroll));
 if(smooth&&typeof chaptersContainer.scrollTo==='function'){
  chaptersContainer.scrollTo({left:clampedScroll,behavior:'smooth'});
 }else{
  chaptersContainer.scrollLeft=clampedScroll;
 }
}
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
 if(view==='map'&&typeof window!=='undefined'&&window.innerWidth<=760){scrollActiveChapterIntoView(false);}
}
const renderBeforeUI=render;render=function(){renderBeforeUI();refreshAppChrome();};
const renderQuizBeforeUI=renderQuiz;renderQuiz=function(){renderQuizBeforeUI();refreshAppChrome();};
if(typeof selectChapter==='function'){
 const origSelectChapter=selectChapter;
 selectChapter=function(c){
  origSelectChapter(c);
  refreshAppChrome();
  if(typeof window!=='undefined'&&window.innerWidth<=760){scrollActiveChapterIntoView(false);}
 };
}
if(typeof setMapSource==='function'){
 const origSetMapSource=setMapSource;
 setMapSource=function(s){
  origSetMapSource(s);
  refreshAppChrome();
  if(typeof window!=='undefined'&&window.innerWidth<=760){scrollActiveChapterIntoView(false);}
 };
}
window.addEventListener('hashchange',closeMoreNavigation);
document.querySelector('#more-dialog')?.addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeMoreNavigation();}});
document.querySelector('#more-dialog')?.addEventListener('close',()=>document.querySelector('.nav-more')?.setAttribute('aria-expanded','false'));
refreshAppChrome();

/* =========================================================================
 * 微信移动端适配（域 2）：真实可视高度 / 软键盘 / 弹窗滚动锁
 * 1) --app-height：visualViewport.height（微信 X5/XWeb 与 iOS WKWebView 均支持）
 *    优先，回退 innerHeight；CSS 用 `100vh` → `var(--app-height,100dvh)` 双写，
 *    老内核无 dvh 时仍能回退 100vh，现代浏览器跟随地址栏伸缩与软键盘。
 * 2) --keyboard-inset / body.keyboard-open：识别软键盘，聚焦控件滚入可视区，
 *    键盘打开时隐藏底部固定导航，避免遮挡输入框。
 * 3) 原生 dialog 滚动锁：打开时固定 body 并记住 scrollY，关闭（含嵌套）后恢复，
 *    防止 iOS 微信背景穿透滚动。
 * 只做布局层处理，不写 localStorage、不请求网络。
 * ========================================================================= */
(function(){
 if(typeof window==='undefined'||typeof document==='undefined')return;
 const docEl=document.documentElement;
 const body=document.body;
 if(!docEl||!body)return;
 const mobileMedia=typeof window.matchMedia==='function'?window.matchMedia('(max-width: 760px)'):null;
 const isMobileViewport=()=>mobileMedia?mobileMedia.matches:(window.innerWidth||0)<=760;
 const TEXT_INPUT_TYPES=['text','email','password','search','tel','url','number','date','datetime-local','month','time','week'];
 const setAppVar=(name,value)=>{if(typeof value==='string')docEl.style.setProperty(name,value);else docEl.style.removeProperty(name);};

 function readViewportMetrics(){
  const vv=window.visualViewport;
  const layoutHeight=Math.max(0,Math.round(window.innerHeight||0));
  const visibleHeight=Math.max(0,Math.round((vv&&typeof vv.height==='number'?vv.height:layoutHeight)||0))||layoutHeight;
  const visibleTop=vv&&typeof vv.offsetTop==='number'?Math.max(0,Math.round(vv.offsetTop)):0;
  const keyboardInset=Math.max(0,layoutHeight-(visibleTop+visibleHeight));
  return {layoutHeight,visibleHeight,visibleTop,keyboardInset};
 }

 function scrollFocusedControlIntoView(){
  const active=document.activeElement;
  if(!active||active===body)return;
  const tag=active.tagName;
  if(tag!=='INPUT'&&tag!=='TEXTAREA'&&tag!=='SELECT')return;
  if(tag==='INPUT'&&TEXT_INPUT_TYPES.indexOf((active.type||'text').toLowerCase())===-1&&(active.type||'')!=='')return;
  const rect=active.getBoundingClientRect();
  if(rect.width<=0&&rect.height<=0)return;
  const vv=window.visualViewport;
  const vTop=vv&&typeof vv.offsetTop==='number'?vv.offsetTop:0;
  const vBottom=vTop+((vv&&typeof vv.height==='number'?vv.height:window.innerHeight)||window.innerHeight||0);
  const margin=18;
  const dialog=typeof active.closest==='function'?active.closest('dialog[open]'):null;
  if(dialog){
   if(rect.bottom>vBottom-margin||rect.top<vTop+margin)active.scrollIntoView({block:'center',inline:'nearest'});
   return;
  }
  if(rect.bottom>vBottom-margin){
   window.scrollBy(0,Math.ceil(rect.bottom-(vBottom-margin)));
  }else if(rect.top<vTop+margin){
   window.scrollBy(0,-Math.ceil(vTop+margin-rect.top));
  }
 }

 let viewportFrame=0;
 function applyViewportVars(){
  viewportFrame=0;
  const metrics=readViewportMetrics();
  setAppVar('--app-height',metrics.visibleHeight+'px');
  setAppVar('--keyboard-inset',metrics.keyboardInset+'px');
  const keyboardOpen=isMobileViewport()&&metrics.keyboardInset>120;
  const wasKeyboardOpen=body.classList.contains('keyboard-open');
  body.classList.toggle('keyboard-open',keyboardOpen);
  if(keyboardOpen){
   if(!wasKeyboardOpen)window.setTimeout(scrollFocusedControlIntoView,120);
   window.setTimeout(scrollFocusedControlIntoView,360);
  }
 }
 function scheduleViewportSync(){
  if(viewportFrame)return;
  if(typeof window.requestAnimationFrame==='function')viewportFrame=window.requestAnimationFrame(applyViewportVars);
  else viewportFrame=window.setTimeout(applyViewportVars,16);
 }

 /* 弹窗滚动锁：dialog 是 top layer，锁 body 不影响弹窗自身定位。 */
 let scrollLocked=false;
 let lockedScrollY=0;
 function countOpenDialogs(){
  let count=0;
  for(const dialog of document.querySelectorAll('dialog[open]'))if(dialog.isConnected)count++;
  return count;
 }
 function restorePageScroll(y){
  window.scrollTo({top:y,left:0,behavior:'auto'});
 }
 function syncDialogScrollLock(){
  const shouldLock=isMobileViewport()&&countOpenDialogs()>0;
  if(shouldLock&&!scrollLocked){
   lockedScrollY=window.scrollY||window.pageYOffset||0;
   body.classList.add('dialog-scroll-locked');
   body.style.top=(-lockedScrollY)+'px';
   scrollLocked=true;
  }else if(!shouldLock&&scrollLocked){
   body.classList.remove('dialog-scroll-locked');
   body.style.top='';
   scrollLocked=false;
   restorePageScroll(lockedScrollY);
  }
 }

 window.addEventListener('resize',scheduleViewportSync,{passive:true});
 window.addEventListener('orientationchange',()=>{scheduleViewportSync();window.setTimeout(scheduleViewportSync,120);window.setTimeout(scheduleViewportSync,360);},{passive:true});
 if(window.visualViewport&&typeof window.visualViewport.addEventListener==='function'){
  window.visualViewport.addEventListener('resize',scheduleViewportSync,{passive:true});
 }
 document.addEventListener('focusin',event=>{
  const target=event.target;
  if(!target||!isMobileViewport())return;
  const tag=target.tagName;
  if(tag!=='INPUT'&&tag!=='TEXTAREA'&&tag!=='SELECT')return;
  if(tag==='INPUT'&&TEXT_INPUT_TYPES.indexOf((target.type||'text').toLowerCase())===-1&&(target.type||'')!=='')return;
  window.setTimeout(scrollFocusedControlIntoView,220);
  window.setTimeout(scrollFocusedControlIntoView,420);
 },true);
 document.addEventListener('close',event=>{
  const target=event.target;
  if(target&&target.tagName==='DIALOG')syncDialogScrollLock();
 },true);
 if(typeof window.MutationObserver==='function'){
  const dialogObserver=new MutationObserver(()=>syncDialogScrollLock());
  dialogObserver.observe(body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
 }
 if(mobileMedia&&typeof mobileMedia.addEventListener==='function')mobileMedia.addEventListener('change',()=>{syncDialogScrollLock();scheduleViewportSync();});
 applyViewportVars();
 syncDialogScrollLock();
})();
