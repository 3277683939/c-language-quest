-- Run only after the website owner approves this specific role assignment.
-- This grants a website role; it preserves existing Auth metadata and progress.
begin;

create or replace function public.cquest_is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and u.raw_app_meta_data ->> 'cquest_role' = 'admin'
  );
$$;
revoke all on function public.cquest_is_admin() from public, anon;
grant execute on function public.cquest_is_admin() to authenticated;

do $$
declare owner_id uuid;
begin
  select id into strict owner_id from auth.users
    where lower(email) = '3277683939@qq.com' and email_confirmed_at is not null;
  update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || '{"cquest_role":"admin"}'::jsonb
    where id = owner_id;
exception
  when no_data_found then
    raise exception 'Owner email must exist and be verified before assigning this role';
end $$;

commit;

select email, raw_app_meta_data ->> 'cquest_role' as website_role
from auth.users where lower(email) = '3277683939@qq.com';
