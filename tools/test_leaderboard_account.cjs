'use strict';
const assert = require('node:assert/strict');
const account = require('../overrides/account.js');
function storage() { const values = new Map(); return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}; }
function setup(fetch, loggedIn=false) {
  account._resetForTesting();
  global.CQUEST_CLOUD_CONFIG = {url:'https://rank-test.supabase.co',publishableKey:'public-test-key'};
  const localStorage=storage(),sessionStorage=storage();
  if(loggedIn) sessionStorage.setItem('cquest_auth_session_rank-test',JSON.stringify({access_token:'TEST_ONLY_ACCESS',refresh_token:'TEST_ONLY_REFRESH',user:{id:'test-user',email:'private@example.test'}}));
  account._setInjectedDeps({fetch,localStorage,sessionStorage});
  account.readLocalProgress();
}
const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
async function run() {
  let requests=[];
  setup(async(url,opts)=>{requests.push({url,opts});return response([{rank:1,solved:12,nickname:'访客可见',mine:false,email:'MUST_NOT_RETURN',user_id:'PRIVATE_ID'}]);});
  const list=await account.leaderboardRpc('list');
  assert.deepEqual(list,[{rank:1,solved:12,nickname:'访客可见',mine:false}]);
  assert.ok(!requests[0].opts.headers.Authorization);
  assert.equal(requests.length,1);
  await assert.rejects(account.leaderboardRpc('join',{nickname:'游客'}),/登录/);
  await assert.rejects(account.leaderboardRpc('../cquest_save_progress'),/不支持/);
  assert.equal(requests.length,1);
  setup(async(url,opts)=>{requests.push({url,opts});return response({joined:true,nickname:'新昵称'});},true);
  assert.equal(account.leaderboardSession().loggedIn,true);
  assert.deepEqual(Object.keys(account.leaderboardSession()).sort(),['configured','loggedIn','pendingMerge']);
  for(const nickname of ['a','a'.repeat(17),'a@qq.com','<img>','a\nb','ab\u200b']) await assert.rejects(account.leaderboardRpc('join',{nickname}),/昵称/);
  const joined=await account.leaderboardRpc('join',{nickname:' 新昵称 ',score:999,user_id:'someone-else'});
  assert.equal(joined.joined,true);
  assert.equal(JSON.parse(requests.at(-1).opts.body).nickname,'新昵称');
  assert.deepEqual(Object.keys(JSON.parse(requests.at(-1).opts.body)),['nickname']);
  assert.ok(requests.at(-1).opts.headers.Authorization);
  setup(async()=>response({code:'PGRST202'},404));
  await assert.rejects(account.leaderboardRpc('list'),/尚未启用/);
  setup(async()=>{throw new TypeError('Failed to fetch');});
  const before=account._getState().status;
  await assert.rejects(account.leaderboardRpc('list'),/无法连接/);
  assert.equal(account._getState().status,before,'leaderboard failure must not change cloud sync status or create reload loops');
  setup(async()=>response([{rank:1,solved:-1,nickname:'bad'}]));
  await assert.rejects(account.leaderboardRpc('list'),/格式异常/);
  setup(async()=>({ok:true,status:200,json:async()=>{account._resetForTesting();return [];}}),true);
  await assert.rejects(account.leaderboardRpc('list'),/账号已切换/);
  console.log('PASS: guest access, private-field filtering, fixed RPC allowlist, authenticated opt-in, nickname checks, unavailable backend, isolated failures and stale-response guard');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
