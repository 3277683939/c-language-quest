'use strict';
const assert=require('node:assert/strict');
const account=require('../overrides/account.js');
const response=(status,data)=>({status,ok:status<300,json:async()=>data});
async function run(){
  account._resetForTesting();
  global.CQUEST_CLOUD_CONFIG={url:'https://test.supabase.co',publishableKey:'public-test-key'};
  const requests=[];
  account._setInjectedDeps({fetch:async(url,options)=>{requests.push({url,options});return url.endsWith('/health')?response(200,{name:'GoTrue'}):response(400,{error_code:'validation_failed'});}});
  let report=await account.checkCloudConnection();
  assert.deepEqual(report.map(r=>r.code),['AUTH-OK','REGISTER-OK']);
  assert.equal(requests.length,2);
  assert.equal(JSON.parse(requests[1].options.body).email,'connection-check.invalid');
  assert.ok(requests.every(r=>!r.options.headers.Authorization),'never transmit a session token');
  assert.equal(account._getState().status,'unconfigured','diagnostic must not alter login/sync state');
  account._setInjectedDeps({fetch:async()=>{throw new TypeError('Failed to fetch');}});
  report=await account.checkCloudConnection();
  assert.deepEqual(report.map(r=>r.code),['AUTH-NET','REGISTER-NET']);
  account._setInjectedDeps({fetch:async()=>{const e=new Error();e.name='AbortError';throw e;}});
  assert.deepEqual((await account.checkCloudConnection()).map(r=>r.code),['AUTH-TIMEOUT','REGISTER-TIMEOUT']);
  account._setInjectedDeps({fetch:async()=>response(401,{})});
  assert.ok((await account.checkCloudConnection()).every(r=>r.code.endsWith('-HTTP401')));
  account._setInjectedDeps({fetch:async()=>response(200,{unexpected:true})});
  assert.ok((await account.checkCloudConnection()).every(r=>r.code.endsWith('-UNEXPECTED')));
  console.log('PASS: real adapter diagnostic path, network/timeout/HTTP distinctions, invalid-only signup probe, no auth/session mutation');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
