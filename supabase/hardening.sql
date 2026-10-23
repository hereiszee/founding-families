-- Founding families: hardening.
-- Run AFTER setup.sql. Paste the whole file into Supabase SQL Editor and click Run.
-- Safe to run again; it won't duplicate anything.

-- 1. Daily usage counters for the Edge Functions (site-wide caps per UTC day).
--    Only the Edge Functions touch this, through bump_usage() with the service role key.
create table if not exists public.api_usage (
  day    date    not null,
  bucket text    not null,
  n      integer not null default 0,
  primary key (day, bucket)
);
alter table public.api_usage enable row level security;
-- No policies on purpose: nobody but the service role (and the function below) can read or write it.
revoke all on table public.api_usage from public, anon, authenticated;

-- Atomically counts one use of p_bucket for today (UTC) and returns true while still within p_cap.
-- Once the cap is reached the counter stops growing and every further call returns false until the next UTC day.
-- The insert ... on conflict do update takes a row lock, so concurrent calls can't both slip past the cap.
create or replace function public.bump_usage(p_bucket text, p_cap integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_bucket is null or char_length(p_bucket) = 0 or char_length(p_bucket) > 64 then
    raise exception 'bump_usage: bad bucket';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'bump_usage: bad cap';
  end if;

  insert into public.api_usage as u (day, bucket, n)
  values ((now() at time zone 'utc')::date, p_bucket, 1)
  on conflict (day, bucket) do update
    set n = u.n + 1
    where u.n < p_cap
  returning u.n into v_n;

  -- No row back means the conflict update was skipped: the cap is already reached.
  return coalesce(v_n <= p_cap, false);
end;
$$;
revoke all on function public.bump_usage(text, integer) from public, anon, authenticated;
grant execute on function public.bump_usage(text, integer) to service_role;

-- 2. Dashboard admins are identified by auth user id, not by the email claim in the login token.
alter table public.dashboard_admins add column if not exists user_id uuid;

-- Backfill: link each email already in dashboard_admins to its confirmed auth user.
-- NOTE: an admin row without a matching auth user (or whose email is not confirmed yet) gets NO access
-- until this backfill is rerun. After creating that login under Authentication > Users, run this file again.
update public.dashboard_admins a
   set user_id = u.id
  from auth.users u
 where lower(u.email) = lower(a.email)
   and u.email_confirmed_at is not null
   and a.user_id is distinct from u.id;

-- When an admin row is added (or its email changed) in the Table Editor, link it to the matching
-- confirmed auth user straight away. A row added before its login exists still needs the backfill above.
create or replace function public.dashboard_admins_fill_user_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.user_id is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.email is not distinct from old.email then
    return new;
  end if;
  new.user_id := null;
  select u.id into new.user_id
    from auth.users u
   where lower(u.email) = lower(new.email)
     and u.email_confirmed_at is not null
   order by u.created_at
   limit 1;
  return new;
end;
$$;
revoke all on function public.dashboard_admins_fill_user_id() from public, anon, authenticated;

drop trigger if exists dashboard_admins_fill_user_id on public.dashboard_admins;
create trigger dashboard_admins_fill_user_id
  before insert or update of email on public.dashboard_admins
  for each row execute function public.dashboard_admins_fill_user_id();

-- True only for a signed-in user whose auth id is linked in dashboard_admins.
-- (An admin row whose user_id is still empty gives no access; rerun the backfill above.)
create or replace function public.is_dashboard_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.dashboard_admins
    where user_id = auth.uid()
  );
$$;
revoke all on function public.is_dashboard_admin() from public;
grant execute on function public.is_dashboard_admin() to anon, authenticated, service_role;

-- 3. Family photos: the Edge Function accepts JPEG, PNG or WebP (it checks the file bytes).
update storage.buckets
   set public = false,
       file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'family-photos';

alter table public.families drop constraint if exists families_photo_path_check;
alter table public.families add constraint families_photo_path_check
  check (photo_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$') not valid; -- new rows only, existing photos are left alone
