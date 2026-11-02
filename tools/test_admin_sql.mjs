// PostgreSQL role checks with synthetic users; never connects to a real account.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {PGlite} = await import(new URL('../.question-import/sql-test-runtime/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href);
const db = new PGlite();
const owner = '00000000-0000-4000-a000-000000000001';
const visitor = '00000000-0000-4000-a000-000000000002';
try {
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to authenticated, anon;
    insert into auth.users values
      ('${owner}','3277683939@qq.com',now(),'{"provider":"email"}',null),
      ('${visitor}','visitor@example.invalid',now(),'{}','{"cquest_role":"admin"}');`);
  const sql = await readFile(new URL('../cloud/grant-owner-admin.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  const meta = await db.query('select raw_app_meta_data from auth.users where id=$1', [owner]);
  assert.equal(meta.rows[0].raw_app_meta_data.provider, 'email');
  await db.exec('set role anon');
  await assert.rejects(db.query('select public.cquest_is_admin()'), e => e.code === '42501');
  await db.exec('reset role; set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  assert.equal((await db.query('select public.cquest_is_admin() as admin')).rows[0].admin, true);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [visitor]);
  assert.equal((await db.query('select public.cquest_is_admin() as admin')).rows[0].admin, false);
  await assert.rejects(db.query("update auth.users set raw_app_meta_data='{\"cquest_role\":\"admin\"}' where id=$1", [visitor]), e => e.code === '42501');
  await db.exec('reset role');
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [owner]);
  await assert.rejects(db.exec(sql), /Owner email must exist and be verified/);
  await db.exec('rollback');
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  assert.equal((await db.query('select public.cquest_is_admin() as admin')).rows[0].admin, false);
  console.log('PASS admin SQL: verified owner, preserved metadata, repeatable grant, anonymous denial, forged user metadata rejected, self-promotion denied, unverified owner rejected.');
} finally { await db.close(); }
