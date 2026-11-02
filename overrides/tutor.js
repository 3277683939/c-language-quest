/* Antigravity bridge and DeepSeek teaching dispatcher. */
const TUTOR_BRIDGE='http://127.0.0.1:14763';
const tutorState={available:false,agentWaiting:false,jobs:{},practiceImages:{}};
try{const jobs=JSON.parse(sessionStorage.getItem('cquest-tutor-jobs')||'{}');for(const [id,j] of Object.entries(jobs))if(j&&typeof j.jobId==='string'&&Number.isFinite(j.started))tutorState.jobs[id]={jobId:j.jobId,started:j.started,status:'pending'};}catch(e){}
function saveTutorJobs(){try{sessionStorage.setItem('cquest-tutor-jobs',JSON.stringify(tutorState.jobs));}catch(e){}}
// Limited Markdown, escaped before formatting. Model output never becomes raw HTML.
function formatTeaching(text){
 const inline=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
 const out=[];let code=null,list=null;
 const closeList=()=>{if(list){out.push('</'+list+'>');list=null;}};
 for(const line of String(text).split(/\r?\n/)){
  if(/^\s*```/.test(line)){closeList();if(code!==null){out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');code=null;}else code=[];continue;}
  if(code!==null){code.push(line);continue;}
  if(!line.trim()){closeList();continue;}
  if(/^\s*([-*_])\1\1+\s*$/.test(line)){closeList();out.push('<hr>');continue;}
  const heading=line.match(/^\s*#{1,6}\s+(.+)/),item=line.match(/^\s*(?:([-*])\s+|\d+[.)、]\s+)(.*)/);
  if(heading){closeList();out.push('<h4>'+inline(heading[1])+'</h4>');}
  else if(item){const tag=item[1]?'ul':'ol';if(list!==tag){closeList();list=tag;out.push('<'+tag+'>');}out.push('<li>'+inline(item[2])+'</li>');}
  else{closeList();out.push('<p>'+inline(line.replace(/^\s*>\s?/,''))+'</p>');}
 }
 closeList();if(code!==null)out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');return out.join('');
}
async function tutorFetch(path,options={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{return await fetch(TUTOR_BRIDGE+path,{...options,signal:controller.signal,cache:'no-store'});}finally{clearTimeout(timer);}}
async function checkTutor(){
 if(window.CQuestDeepSeek?.isSelected()){CQuestDeepSeek.updatePanels();return;}
 const wasAvailable=tutorState.available;
 try{const res=await tutorFetch('/health');if(!res.ok)throw Error('unavailable');const data=await res.json();tutorState.available=!!data.ready;tutorState.agentWaiting=!!data.agentWaiting;}
 catch(e){tutorState.available=false;tutorState.agentWaiting=false;}
 updateTutorPanel();
 if(tutorState.available)for(const [id,job] of Object.entries(tutorState.jobs))if(job.status==='error'){if(job.jobId){job.status='pending';pollTutor(id);}else if(!wasAvailable)requestTutor(id);}
}
function updateTutorPanel(){
 if(window.CQuestDeepSeek?.isSelected()){CQuestDeepSeek.updatePanels();return;}
 document.querySelectorAll('[data-tutor-connection]').forEach(el=>el.textContent=tutorState.agentWaiting?'辅导会话已就绪':tutorState.available?'请启动辅导会话':'尚未连接');
 document.querySelectorAll('[data-tutor-panel]').forEach(panel=>{
 const id=panel.dataset.tutorPanel,job=tutorState.jobs[id];
 const status=panel.querySelector('[data-tutor-status]');if(!status)return;
 if(job?.status==='sending')status.textContent='正在发送当前题目…';
 else if(job?.status==='working')status.textContent='Antigravity 正在分析题目…';
 else if(job?.status==='pending')status.textContent=tutorState.agentWaiting?'已送达，等待 Antigravity 开始讲解…':'题目已排队，等待 Antigravity 辅导会话启动…';
 else if(job?.status==='error')status.textContent=job.message||'连接中断，恢复后会自动重试，也可手动重试。';
 else if(tutorState.available&&tutorState.agentWaiting)status.textContent='Antigravity 辅导会话已就绪';
 else if(tutorState.available)status.textContent='桥接已启动，请在 Antigravity 开始辅导会话';
 else status.textContent='Antigravity 辅导会话尚未连接';
 const button=panel.querySelector('[data-tutor-retry]');if(button)button.hidden=!!job&&['sending','pending','working'].includes(job.status);
 });
}
function tutorPanel(id){
 if(window.CQuestDeepSeek?.isSelected())return CQuestDeepSeek.panel(id);
 const e=esc(id);return `<section class="ai-teaching" data-tutor-panel="${e}"><div class="ai-heading"><strong>✦ Antigravity AI 讲解</strong><span data-tutor-status>正在检查连接…</span></div><p>答错后自动发送当前题目，讲解完成后直接显示在这里。</p><div class="list-actions"><button class="secondary" data-tutor-retry onclick="requestTutor('${e}')">生成讲解 ↗</button><button class="quiet" onclick="pauseQuiz();location.hash='coach'">连接说明</button></div></section>`;
}
async function imageData(url,signal){
 if(!url)return null;
 const response=await fetch(url,{cache:'force-cache',signal});if(!response.ok)throw Error('原题图片读取失败');
 const blob=await response.blob();if(blob.size>1400000)throw Error('原题图片过大');
 return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
}
async function requestTutor(id,options={}){
 if(window.CQuestDeepSeek?.isSelected())return CQuestDeepSeek.request(id,options);
 return requestAntigravityTutor(id);
}
async function requestAntigravityTutor(id){
 ensureTeaching();const prior=tutorState.jobs[id];if(prior&&['sending','pending','working'].includes(prior.status))return;
 if(prior?.jobId){prior.status='pending';delete prior.message;updateTutorPanel();pollTutor(id);return;}
 tutorState.jobs[id]={status:'sending'};updateTutorPanel();
 try{
  const ctx=getTeachingContext(id);if(!ctx)throw Error('找不到题目');
  const q=Q.find(x=>x.id===id),question={questionId:id,kind:ctx.kind,source:ctx.source,stem:ctx.stem||'',options:ctx.options||[],selected:ctx.selected||[],referenceAnswer:ctx.referenceAnswer||ctx.reference||null,learnerDraft:(ctx.learnerDraft||'').slice(0,12000)};
  if(ctx.kind==='practice')question.stem=(ctx.text||'').slice(0,12000);
  const url=q&&(q.image||q.sourceImage);if(url)question.image=await imageData(url);else if(tutorState.practiceImages[id])question.image=tutorState.practiceImages[id];
  const res=await tutorFetch('/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question})});if(!res.ok)throw Error('辅导连接暂不可用，请检查 Antigravity。');
  const data=await res.json();if(typeof data.jobId!=='string')throw Error('桥接返回异常');
  tutorState.jobs[id]={status:'pending',jobId:data.jobId,started:Date.now()};saveTutorJobs();updateTutorPanel();pollTutor(id);
 }catch(e){tutorState.jobs[id]={status:'error',message:'尚未连接 Antigravity。连接恢复后会自动重试。'};updateTutorPanel();}
}
async function pollTutor(id){
 if(window.CQuestDeepSeek?.isSelected())return;
 const job=tutorState.jobs[id];if(!job?.jobId)return;
 if(Date.now()-job.started>10*60*1000){job.status='error';job.message='等待讲解超时，请启动辅导会话后重试。';delete job.jobId;saveTutorJobs();updateTutorPanel();return;}
 try{const r=await tutorFetch('/jobs/'+encodeURIComponent(job.jobId));if(!r.ok){delete job.jobId;throw Error('请求已失效，请重试。');}const data=await r.json();job.status=data.status;updateTutorPanel();
  if(data.status==='answered'){if(window.CQuestDeepSeek?.isSelected())return;submitTeaching({...data.lesson,questionId:id});delete tutorState.jobs[id];saveTutorJobs();toast('Antigravity 讲解已到达');return;}
  if(!['pending','working'].includes(data.status))throw Error('未知状态');
 }catch(e){job.status='error';saveTutorJobs();updateTutorPanel();return;}
 setTimeout(()=>pollTutor(id),2000);
}
window.addEventListener('DOMContentLoaded',()=>{checkTutor();if(!window.CQuestDeepSeek?.isSelected())for(const id of Object.keys(tutorState.jobs))pollTutor(id);setInterval(checkTutor,10000);});
