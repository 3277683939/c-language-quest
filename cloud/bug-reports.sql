-- Private mobile bug inbox. Guests can submit bounded reports, never read them.
begin;
create table if not exists public.cquest_bug_reports (
  id uuid primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  category text not null,
  description text not null check(char_length(description) between 10 and 2000),
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check(status in ('open','resolved'))
);
create index if not exists cquest_bug_created_idx on public.cquest_bug_reports(created_at);
alter table public.cquest_bug_reports enable row level security;
alter table public.cquest_bug_reports force row level security;
revoke all on public.cquest_bug_reports from public,anon,authenticated;

create or replace function public.cquest_bug_admin()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid()
   and u.email_confirmed_at is not null and u.raw_app_meta_data->>'cquest_role'='admin');
$$;

create or replace function public.cquest_bug_submit(report_id uuid,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare detail text; kind text; ctx jsonb; uid uuid:=auth.uid();
begin
 if report_id is null or jsonb_typeof(payload) is distinct from 'object'
   or payload-array['category','description','context'] <> '{}'::jsonb
   or jsonb_typeof(payload->'description') is distinct from 'string'
   or jsonb_typeof(payload->'category') is distinct from 'string' then
   raise sqlstate 'PT400' using message='Invalid report';
 end if;
 detail:=btrim(payload->>'description');kind:=payload->>'category';
 ctx:=coalesce(payload->'context','{}'::jsonb);
 if char_length(detail) not between 10 and 2000
   or kind not in ('按钮','显示','题目内容','注册登录','其他')
   or jsonb_typeof(ctx) is distinct from 'object' or octet_length(ctx::text)>1200
   or ctx-array['page','questionId','mode','position','viewport','browser'] <> '{}'::jsonb then
   raise sqlstate 'PT400' using message='Invalid report fields';
 end if;
 -- Keep only coarse reproduction context; never accept arbitrary URLs or keys.
 if (ctx ? 'page' and (jsonb_typeof(ctx->'page')<>'string' or ctx->>'page' not in ('map','random','wrong','favorites','practice','coach','library','progress','account','leaderboard','feedback')))
   or (ctx ? 'questionId' and (jsonb_typeof(ctx->'questionId')<>'string' or ctx->>'questionId' !~ '^[A-Za-z0-9:_-]{0,100}$'))
   or (ctx ? 'mode' and ctx->>'mode' not in ('choice','practice','page'))
   or (ctx ? 'browser' and ctx->>'browser' not in ('WeChat','Huawei','Edge','Chrome','Firefox','Safari','Other'))
   or (ctx ? 'position' and (jsonb_typeof(ctx->'position')<>'number' or ctx->>'position' !~ '^[0-9]{1,6}$'))
   or (ctx ? 'viewport' and (jsonb_typeof(ctx->'viewport')<>'object'
     or (ctx->'viewport')-array['width','height']<>'{}'::jsonb
     or coalesce(ctx->'viewport'->>'width','') !~ '^[0-9]{1,5}$'
     or coalesce(ctx->'viewport'->>'height','') !~ '^[0-9]{1,5}$')) then
   raise sqlstate 'PT400' using message='Invalid context';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(513817204);
 if exists(select 1 from public.cquest_bug_reports r where r.id=report_id) then
   return jsonb_build_object('accepted',true,'id',report_id);
 end if;
 if (select count(*) from public.cquest_bug_reports)>=5000
   or (select count(*) from public.cquest_bug_reports where created_at>now()-interval '1 day')>=200
   or (uid is not null and (select count(*) from public.cquest_bug_reports where user_id=uid and created_at>now()-interval '1 day')>=10)
   or (uid is null and (select count(*) from public.cquest_bug_reports where user_id is null and created_at>now()-interval '1 hour')>=30) then
   raise sqlstate 'PT429' using message='Feedback limit reached';
 end if;
 insert into public.cquest_bug_reports(id,user_id,category,description,context)
 values(report_id,uid,kind,detail,ctx);
 return jsonb_build_object('accepted',true,'id',report_id);
end;
$$;

create or replace function public.cquest_bug_list()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.cquest_bug_admin() then raise sqlstate 'PT403' using message='Admin required';end if;
 return coalesce((select jsonb_agg(to_jsonb(r)) from
   (select id,created_at,category,description,context,status from public.cquest_bug_reports
    order by created_at desc,id limit 100) r),'[]'::jsonb);
end;
$$;
create or replace function public.cquest_bug_resolve(report_id uuid,new_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.cquest_bug_admin() then raise sqlstate 'PT403' using message='Admin required';end if;
 if new_status is null or new_status not in ('open','resolved') then raise sqlstate 'PT400' using message='Invalid status';end if;
 update public.cquest_bug_reports set status=new_status where id=report_id;
 return jsonb_build_object('updated',found);
end;
$$;
revoke all on function public.cquest_bug_admin() from public,anon,authenticated;
revoke all on function public.cquest_bug_submit(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.cquest_bug_list() from public,anon,authenticated;
revoke all on function public.cquest_bug_resolve(uuid,text) from public,anon,authenticated;
grant execute on function public.cquest_bug_submit(uuid,jsonb) to anon,authenticated;
grant execute on function public.cquest_bug_list() to authenticated;
grant execute on function public.cquest_bug_resolve(uuid,text) to authenticated;
commit;
