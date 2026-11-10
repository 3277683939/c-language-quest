'use strict';
const assert=require('node:assert/strict');
const account=require('../overrides/account.js');
const id='00000000-0000-4000-b000-000000000001';
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
function setup(fetch,admin=false){account._resetForTesting();global.CQUEST_CLOUD_CONFIG={url:'https://bug-test.supabase.co',publishableKey:'public-test-key'};const localStorage=storage(),sessionStorage=storage();if(admin)sessionStorage.setItem('cquest_auth_session_bug-test',JSON.stringify({access_token:'TEST_ONLY_ACCESS',refresh_token:'TEST_ONLY_REFRESH',user:{id:'test-user',app_metadata:{cquest_role:'admin'}}}));account._setInjectedDeps({fetch,localStorage,sessionStorage});account.readLocalProgress();}
(async()=>{
 let calls=[];
 setup(async(url,opts)=>{calls.push({url,opts});return response({accepted:true,id});});
 await account.bugReportRpc('submit',{reportId:id,category:'按钮',description:'点击下一题按钮后页面没有响应',context:{page:'map',questionId:'n7-1',mode:'choice',position:2,viewport:{width:390,height:844},browser:'Huawei',token:'SECRET',email:'PRIVATE',url:'https://example.com/?token=secret',draft:'DO_NOT_SEND'}});
 assert.equal(calls.length,1);assert.ok(!calls[0].opts.headers.Authorization);
 const body=JSON.parse(calls[0].opts.body);assert.deepEqual(Object.keys(body.payload.context).sort(),['browser','mode','page','position','questionId','viewport']);assert.ok(!calls[0].opts.body.includes('SECRET'));
 await assert.rejects(account.bugReportRpc('list'),/管理员/);
 await assert.rejects(account.bugReportRpc('../cquest_save_progress'),/不支持/);
 await assert.rejects(account.bugReportRpc('submit',{reportId:id,category:'按钮',description:'太短'}),/10/);
 setup(async()=>{throw new TypeError('network');});const status=account._getState().status;await assert.rejects(account.bugReportRpc('submit',{reportId:id,category:'按钮',description:'点击下一题按钮后页面没有响应'}),/保留草稿/);assert.equal(account._getState().status,status);
 setup(async()=>response({code:'PGRST202'},404));await assert.rejects(account.bugReportRpc('submit',{reportId:id,category:'按钮',description:'点击下一题按钮后页面没有响应'}),/尚未启用/);
 setup(async(url,opts)=>{calls.push({url,opts});return response([{id,created_at:'2026-11-10',category:'按钮',description:'PRIVATE REPORT',context:{page:'map',token:'HIDDEN'},status:'open',user_id:'HIDDEN'}]);},true);
 assert.equal(account.bugReportSession().admin,true);const rows=await account.bugReportRpc('list');assert.ok(!('user_id' in rows[0]));assert.ok(!('token' in rows[0].context));assert.ok(calls.at(-1).opts.headers.Authorization);
 setup(async()=>({ok:true,json:async()=>{account._resetForTesting();return {accepted:true,id};}}));await assert.rejects(account.bugReportRpc('submit',{reportId:id,category:'按钮',description:'点击下一题按钮后页面没有响应'}),/账号已切换/);
 console.log('PASS: fixed endpoints, guest access, admin guard, private field stripping, no sync interference and stale-response guard');
})().catch(e=>{console.error(e);process.exitCode=1;});
