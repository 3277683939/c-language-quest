/* Actual PostgreSQL semantics in an in-memory WASM instance; no live account. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const moduleURL = new URL('../.question-import/sql-test-runtime/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url);
const {PGlite} = await import(moduleURL.href);
const db = new PGlite();
const alice = '00000000-0000-4000-a000-000000000001';
const bob = '00000000-0000-4000-a000-000000000002';
let checks = 0;
try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to authenticated, anon;
    insert into auth.users values('${alice}'),('${bob}');
  `);
  const sql = await readFile(new URL('../cloud/supabase.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // Migration is repeatable and never drops user records.
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.cquest_progress'), e => e.code === '42501'); checks++;
  await assert.rejects(db.query('select * from public.cquest_save_progress(0,\'{}\')'), e => e.code === '42501'); checks++;
  await db.exec('reset role; set role authenticated');
  await db.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [alice]);
  let result = await db.query('select * from public.cquest_save_progress($1,$2::jsonb)', [0, JSON.stringify({schema:1, draft:'Alice draft'})]);
  assert.equal(Number(result.rows[0].revision), 1); checks++;
  await assert.rejects(db.query('select * from public.cquest_save_progress(0,\'{}\')'), e => e.code === 'PT409'); checks++;
  const unchanged = await db.query('select document,revision from public.cquest_progress');
  assert.equal(unchanged.rows[0].document.draft, 'Alice draft'); checks++;
  await db.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [bob]);
  result = await db.query('select * from public.cquest_progress where user_id=$1', [alice]);
  assert.equal(result.rows.length, 0); checks++;
  result = await db.query('update public.cquest_progress set document=\'{}\' where user_id=$1 returning user_id', [alice]);
  assert.equal(result.rows.length, 0); checks++;
  await assert.rejects(db.query('insert into public.cquest_progress(user_id,document) values($1,\'{}\')', [alice]), e => e.code === '42501'); checks++;
  result = await db.query('select * from public.cquest_save_progress(0,\'{"draft":"Bob draft"}\')');
  assert.equal(Number(result.rows[0].revision), 1); checks++;
  await db.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [alice]);
  result = await db.query('select * from public.cquest_save_progress(1,\'{"draft":"Alice updated"}\')');
  assert.equal(Number(result.rows[0].revision), 2); checks++;
  await assert.rejects(db.query('select * from public.cquest_save_progress(2,\'[]\')'), e => e.code === 'PT400'); checks++;
  await assert.rejects(db.query('select * from public.cquest_save_progress($1,$2::jsonb)', [2, JSON.stringify({draft:'x'.repeat(2097152)})]), e => e.code === 'PT400'); checks++;
  console.log(`PASS: ${checks} PostgreSQL checks (RLS ownership, anonymous denial, revisions, payload limits).`);
} finally {
  await db.close();
}
