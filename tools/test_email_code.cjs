'use strict';
const assert=require('node:assert/strict');
const account=require('../overrides/account.js');
global.FormData=class {constructor(form){this.fields=form.fields;}get(k){return this.fields[k]??null;}};
const form=(fields)=>({fields,querySelector:()=>({value:fields.code})});
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),data};};
const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
let local,session,notices,calls;
function setup(fetch){account._resetForTesting();global.CQUEST_CLOUD_CONFIG={url:'https://test.supabase.co',publishableKey:'public-test-key',emailCodeEnabled:true};local=storage();session=storage();notices=[];calls=[];account._setInjectedDeps({fetch:async(url,opts)=>{calls.push({url,opts});return fetch(url,opts);},localStorage:local,sessionStorage:session,now:()=>100000});account.attach({getState:()=>({answers:{},wrong:[],favorites:[]}),replaceState:()=>{throw Error('verification must not replace progress');},render:()=>{},toast:m=>notices.push(m)});}
(async()=>{
 setup(async()=>response({user:{id:'test',email:'learner@example.test',email_confirmed_at:'2026-01-01'},access_token:'TEST_SECRET',refresh_token:'TEST_REFRESH'}));
 await account.handleEmailCode(form({email:'learner@example.test',code:'12345678'}));
 assert.ok(calls[0].url.endsWith('/auth/v1/verify'));
 assert.deepEqual(JSON.parse(calls[0].opts.body),{type:'email',email:'learner@example.test',token:'12345678'});
 assert.ok(notices.at(-1).includes('验证成功'));
 assert.equal(account._getState().currentUser,null);assert.equal(account._getState().currentSession,null);
 assert.ok(!JSON.stringify([...local.data,...session.data]).includes('TEST_SECRET'));
 setup(async()=>response({error_code:'otp_expired'},403));await account.handleEmailCode(form({email:'learner@example.test',code:'123456'}));assert.ok(notices.at(-1).includes('已过期'));
 setup(async()=>response({}));await account.handleEmailCode(form({email:'learner@example.test'}),true);await account.handleEmailCode(form({email:'learner@example.test'}),true);assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/resend'));assert.deepEqual(JSON.parse(calls[0].opts.body),{type:'signup',email:'learner@example.test'});
 setup(async()=>{throw new TypeError('Failed to fetch');});await account.handleEmailCode(form({email:'learner@example.test',code:'123456'}));assert.match(notices.at(-1),/无法连接/);
 setup(async()=>response({}));await account.handleEmailCode(form({email:'learner@example.test',code:'bad'}));assert.equal(calls.length,0);
 setup(async()=>response({user:{id:'wrong',email:'someone@example.test',email_confirmed_at:'2026-01-01'}}));await account.handleEmailCode(form({email:'learner@example.test',code:'123456'}));assert.match(notices.at(-1),/未能确认/);
 global.CQUEST_CLOUD_CONFIG.emailCodeEnabled=false;calls=[];await account.handleEmailCode(form({email:'learner@example.test',code:'123456'}));assert.equal(calls.length,0);
 console.log('PASS: email code verification, expired/network/malformed responses, resend cooldown, no token persistence or progress replacement');
})().catch(e=>{console.error(e);process.exitCode=1;});
