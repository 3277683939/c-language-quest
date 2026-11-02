'use strict';
const assert = require('node:assert/strict');
const account = require('../overrides/account.js');
global.FormData = class {constructor(form){this.data=form.data;}get(k){return this.data[k] ?? null;}};
const blank = () => ({version:1,answers:{},wrong:[],favorites:[],levels:{},days:[],drafts:{},selfChecks:{},teaching:{},session:null});
function storage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
const response = (data,status=200) => ({ok:status<400,status,json:async()=>data});
async function fixture(guest=false){
  account._resetForTesting();
  let state=blank(), remote=null, revision=0, hold=null, stamp=1000;
  const local=storage(), session=storage(), timers=[];
  if(guest){state.answers.guestQuestion={attempts:1,correct:1,date:'2026-11-02',last:true};local.setItem('c-quest-progress-v1',JSON.stringify(state));}
  global.CQUEST_CLOUD_CONFIG={provider:'supabase',url:'https://raceproject.supabase.co',publishableKey:'sb_publishable_000000000000000000000000'};
  const user={id:'00000000-0000-4000-a000-000000000001',email:'test@example.invalid'};
  account._setInjectedDeps({localStorage:local,sessionStorage:session,now:()=>++stamp,timer:(cb,ms)=>{timers.push({cb,ms});return null;},fetch:async(url,options={})=>{
    if(url.includes('/auth/v1/token'))return response({access_token:'fake-test-access',refresh_token:'fake-test-refresh',user,expires_in:3600});
    if(url.includes('/auth/v1/user'))return response(user);
    if(url.includes('/rpc/cquest_save_progress')){
      const body=JSON.parse(options.body);
      if(hold)await hold;
      remote=body.payload;revision++;
      return response([{revision,updated_at:'2026-11-02T12:00:00Z'}]);
    }
    if(url.includes('/rest/v1/cquest_progress'))return response(remote?[{revision,document:remote}]:[]);
    return response({});
  }});
  account.attach({getState:()=>state,replaceState:s=>{state=s;},render(){},toast(){}});
  await account.handleLogin({data:{email:user.email,password:'synthetic-password'},querySelector(){return {value:''};}});
  return {get state(){return state;},set state(s){state=s;},get remote(){return remote;},local,timers,pauseRPC(){let release;hold=new Promise(r=>{release=r;});return ()=>{hold=null;release();};}};
}
async function waitForSyncRPC(){for(let i=0;i<10;i++)await Promise.resolve();}
async function inFlightEdit(){
  const f=await fixture();
  f.state.answers.first={attempts:1,correct:1,date:'2026-11-02',last:true};account.saveLocalProgress(f.state);
  const release=f.pauseRPC();const pending=account.handleSyncNow();await waitForSyncRPC();
  // Match the application: subsequent answers mutate the same live state object.
  f.state.answers.second={attempts:1,correct:0,date:'2026-11-02',last:false};account.saveLocalProgress(f.state);
  release();await pending;
  assert.ok(f.state.answers.second,'同步返回后丢失了请求期间新做的第二题');
}
async function cloudOnlyNeverUploadsGuest(){
  const f=await fixture(true);
  await account.handleMergeChoice('replace');
  assert.equal(f.state.answers.guestQuestion,undefined,'选择仅使用账号存档后仍保留并上传了游客答题');
  assert.equal(f.remote?.answers?.guestQuestion,undefined,'游客题目被上传到新账号');
  assert.ok(f.local.getItem('c-quest-progress-v1'),'游客独立备份被删除');
}
async function remoteApplyDoesNotScheduleEcho(){
  const f=await fixture();
  f.timers.length=0;
  await account.handleSyncNow();
  assert.ok(!f.timers.some(t=>t.ms===300),'没有本地新改动，远端写回却反复排队再次同步');
}
(async()=>{
  let failed=0;
  for(const [name,test] of Object.entries({inFlightEdit,cloudOnlyNeverUploadsGuest,remoteApplyDoesNotScheduleEcho})){
    try{await test();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}
  }
  account._resetForTesting();
  if(failed)process.exitCode=1;
})();
