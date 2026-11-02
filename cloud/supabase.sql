-- Run once in your own Supabase project's SQL editor.
-- No service_role key is required by the website. Every request is scoped by auth.uid().
begin;

create table if not exists public.cquest_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  document jsonb not null,
  updated_at timestamptz not null default now(),
  constraint cquest_document_object check (jsonb_typeof(document) = 'object'),
  constraint cquest_document_size check (octet_length(document::text) <= 2097152)
);

alter table public.cquest_progress enable row level security;
alter table public.cquest_progress force row level security;
revoke all on public.cquest_progress from anon;
revoke all on public.cquest_progress from authenticated;
grant select, insert, update on public.cquest_progress to authenticated;

drop policy if exists cquest_read_own on public.cquest_progress;
create policy cquest_read_own on public.cquest_progress for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists cquest_insert_own on public.cquest_progress;
create policy cquest_insert_own on public.cquest_progress for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists cquest_update_own on public.cquest_progress;
create policy cquest_update_own on public.cquest_progress for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Optimistic concurrency: stale clients must re-read and merge, never overwrite.
create or replace function public.cquest_save_progress(expected_revision bigint, payload jsonb)
returns table(revision bigint, updated_at timestamptz)
language plpgsql security invoker set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  current_revision bigint;
begin
  if account_id is null then
    raise sqlstate 'PT401' using message = 'Authentication required';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise sqlstate 'PT400' using message = 'Invalid revision';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object'
     or octet_length(payload::text) > 2097152 then
    raise sqlstate 'PT400' using message = 'Invalid progress document';
  end if;

  select p.revision into current_revision from public.cquest_progress p
    where p.user_id = account_id for update;
  if found then
    if current_revision <> expected_revision then
      raise sqlstate 'PT409' using message = 'Progress changed; read and merge again';
    end if;
    return query update public.cquest_progress p
      set document = payload, revision = p.revision + 1, updated_at = now()
      where p.user_id = account_id returning p.revision, p.updated_at;
  else
    if expected_revision <> 0 then
      raise sqlstate 'PT409' using message = 'Progress changed; read and merge again';
    end if;
    begin
      return query insert into public.cquest_progress(user_id, revision, document)
        values(account_id, 1, payload)
        returning cquest_progress.revision, cquest_progress.updated_at;
    exception when unique_violation then
      raise sqlstate 'PT409' using message = 'Progress changed; read and merge again';
    end;
  end if;
end;
$$;
revoke all on function public.cquest_save_progress(bigint, jsonb) from public;
revoke all on function public.cquest_save_progress(bigint, jsonb) from anon;
grant execute on function public.cquest_save_progress(bigint, jsonb) to authenticated;

commit;
