-- Opt-in learning leaderboard. Run after supabase.sql and leaderboard-questions.sql.
-- No email, UUID, draft, raw answer or client-supplied score is publicly returned.
begin;
create table if not exists public.cquest_rank_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 16
    and nickname = btrim(nickname) and nickname !~ '[[:cntrl:]@<>]')
);
alter table public.cquest_rank_profiles enable row level security;
alter table public.cquest_rank_profiles force row level security;
revoke all on public.cquest_rank_profiles from public, anon, authenticated;

create or replace function public.cquest_rank_profile()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('joined',true,'nickname',p.nickname)
    from public.cquest_rank_profiles p where p.user_id = auth.uid()),
    '{"joined":false,"nickname":""}'::jsonb);
$$;

create or replace function public.cquest_rank_join(nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_id uuid := auth.uid(); clean_name text := btrim(nickname);
begin
  if account_id is null or not exists(select 1 from auth.users u
    where u.id=account_id and u.email_confirmed_at is not null) then
    raise sqlstate 'PT401' using message='Verified account required';
  end if;
  if clean_name is null or char_length(clean_name) not between 2 and 16
    or clean_name ~ '[[:cntrl:]@<>]' then
    raise sqlstate 'PT400' using message='Invalid nickname';
  end if;
  insert into public.cquest_rank_profiles as p(user_id,nickname)
    values(account_id,clean_name)
    on conflict(user_id) do update set nickname=excluded.nickname;
  return jsonb_build_object('joined',true,'nickname',clean_name);
end;
$$;

create or replace function public.cquest_rank_leave()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message='Authentication required'; end if;
  delete from public.cquest_rank_profiles p where p.user_id=auth.uid();
  return '{"joined":false,"nickname":""}'::jsonb;
end;
$$;

create or replace function public.cquest_rank_list()
returns table(rank bigint,nickname text,solved bigint,mine boolean)
language sql stable security definer set search_path = '' as $$
  with scores as (
    select p.user_id,p.nickname,
      (select count(*) from jsonb_each(case
        when jsonb_typeof(s.document->'answers')='object' then s.document->'answers'
        else '{}'::jsonb end) a
        join public.cquest_rank_questions q on q.id=a.key and q.active
        where jsonb_typeof(a.value->'correct')='number'
          and jsonb_typeof(a.value->'attempts')='number'
          and a.value->'correct' > '0'::jsonb
          and a.value->'correct' <= a.value->'attempts') as solved
    from public.cquest_rank_profiles p
    join auth.users u on u.id=p.user_id and u.email_confirmed_at is not null
    left join public.cquest_progress s on s.user_id=p.user_id
  ), ranked as (
    select rank() over(order by s.solved desc) as position,s.* from scores s
  )
  select r.position,r.nickname,r.solved,coalesce(r.user_id=auth.uid(),false)
    from ranked r order by r.solved desc,r.nickname,r.user_id limit 50;
$$;

revoke all on function public.cquest_rank_list() from public,anon,authenticated;
revoke all on function public.cquest_rank_profile() from public,anon,authenticated;
revoke all on function public.cquest_rank_join(text) from public,anon,authenticated;
revoke all on function public.cquest_rank_leave() from public,anon,authenticated;
grant execute on function public.cquest_rank_list() to anon,authenticated;
grant execute on function public.cquest_rank_profile() to authenticated;
grant execute on function public.cquest_rank_join(text) to authenticated;
grant execute on function public.cquest_rank_leave() to authenticated;
commit;
