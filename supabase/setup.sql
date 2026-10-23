-- Founding families: database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, and click Run.
-- It's safe to run again; it won't duplicate anything.

-- 1. Who can open the dashboard.
create table if not exists public.dashboard_admins (
  email text primary key
);
alter table public.dashboard_admins enable row level security;
-- (No policies on purpose: this list is only editable from the Supabase dashboard.)

-- PUT THE REAL ADMIN EMAILS HERE when you run this (do not commit them: the repo is public).
-- Each one needs a login under Authentication > Users. Then run hardening.sql to link them to those logins.
insert into public.dashboard_admins (email) values
  ('you@example.com'),
  ('second-admin@example.com')
on conflict do nothing;

-- Admins are matched by auth user id (user_id), not by the email in the login token.
-- user_id is linked from auth.users by email in hardening.sql: run that file after creating the
-- admin's login under Authentication > Users, or the admin won't get access.
alter table public.dashboard_admins add column if not exists user_id uuid;

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
grant execute on function public.is_dashboard_admin() to anon, authenticated;

-- 2. The submissions.
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  lang        text not null default 'en' check (lang in ('en','he')),
  family_name text not null check (char_length(family_name) between 1 and 120),
  husband     text check (char_length(husband) <= 120),
  wife        text check (char_length(wife) <= 120),
  contact     text check (char_length(contact) <= 200),
  kids        jsonb not null default '[]' check (jsonb_typeof(kids) = 'array' and jsonb_array_length(kids) <= 20),
  points      jsonb not null default '[]' check (jsonb_typeof(points) = 'array' and jsonb_array_length(points) <= 30),
  blurb       text check (char_length(blurb) <= 4000),
  photo_path  text check (photo_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$'),
  source      text not null default 'form',
  ip_hash     text
);
alter table public.families add column if not exists ip_hash text;
create index if not exists families_ip_hash_idx on public.families (ip_hash);
alter table public.families enable row level security;

-- Submissions come in through the submit-profile Edge Function (which enforces the
-- per-IP limit), so the public key gets no direct insert access.
drop policy if exists "Anyone can submit a profile" on public.families;

drop policy if exists "Admins can read profiles" on public.families;
create policy "Admins can read profiles" on public.families
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "Admins can edit profiles" on public.families;
create policy "Admins can edit profiles" on public.families
  for update to authenticated using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());

drop policy if exists "Admins can delete profiles" on public.families;
create policy "Admins can delete profiles" on public.families
  for delete to authenticated using (public.is_dashboard_admin());

-- 3. Family photos: a private bucket. Uploads go through the Edge Function; only admins can view or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('family-photos', 'family-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Anyone can upload a family photo" on storage.objects;

drop policy if exists "Admins can view family photos" on storage.objects;
create policy "Admins can view family photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'family-photos' and public.is_dashboard_admin());

drop policy if exists "Admins can delete family photos" on storage.objects;
create policy "Admins can delete family photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'family-photos' and public.is_dashboard_admin());
