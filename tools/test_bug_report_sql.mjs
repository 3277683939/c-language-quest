import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(new URL('../.question-import/sql-test-runtime/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href);
const db=new PGlite();
const user='00000000-0000-4000-a000-000000000001',admin='00000000-0000-4000-a000-000000000002';
const id=n=>`00000000-0000-4000-b000-${String(n).padStart(12,'0')}`;
const role=async(who,uid='')=>{await db.exec('reset role;set role '+who);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);};
const payload={category:'按钮',description:'手机做完题后点击下一题没有反应',context:{page:'map',mode:'choice',questionId:'n7-1',position:1,viewport:{width:390,height:844},browser:'Huawei'}};
const submit=(n,p=payload)=>db.query('select public.cquest_bug_submit($1,$2::jsonb) result',[id(n),JSON.stringify(p)]);
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;
 insert into auth.users values('${user}',now(),'{}','{"cquest_role":"admin"}'),('${admin}',now(),'{"cquest_role":"admin"}','{}');`);
 const sql=await readFile(new URL('../cloud/bug-reports.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 await role('anon');
 assert.equal((await submit(1)).rows[0].result.accepted,true);
 await submit(1); // A replay after a dropped response must not add a second row.
 await assert.rejects(db.query('select * from public.cquest_bug_reports'),e=>e.code==='42501');
 await assert.rejects(db.query('select public.cquest_bug_list()'),e=>e.code==='42501');
 await assert.rejects(db.query("select public.cquest_bug_resolve($1,'resolved')",[id(1)]),e=>e.code==='42501');
 for(const p of [{...payload,description:'短'},{...payload,token:'secret'},{...payload,context:{url:'https://example.com/?token=secret'}},{...payload,context:{questionId:'bad?token=secret'}}])await assert.rejects(submit(2,p),e=>e.code==='PT400');
 await role('authenticated',user);
 await assert.rejects(db.query('select public.cquest_bug_list()'),e=>e.code==='PT403','user_metadata must not grant admin');
 for(let n=2;n<12;n++)await submit(n);
 await assert.rejects(submit(12),e=>e.code==='PT429');
 await role('authenticated',admin);
 const rows=(await db.query('select public.cquest_bug_list() result')).rows[0].result;
 assert.equal(rows.length,11);assert.ok(rows.every(r=>!('user_id' in r)));
 assert.equal(rows.filter(r=>r.id===id(1)).length,1);
 assert.deepEqual((await db.query("select public.cquest_bug_resolve($1,'resolved') result",[id(1)])).rows[0].result,{updated:true});
 await assert.rejects(db.query("select public.cquest_bug_resolve($1,'deleted')",[id(1)]),e=>e.code==='PT400');
 await role('anon');for(let n=20;n<49;n++)await submit(n);
 await assert.rejects(submit(49),e=>e.code==='PT429');
 console.log('PASS: guest submission, private RLS inbox, no user metadata privilege, admin list/resolve, idempotency, field limits and server rate limits');
}finally{await db.close();}
