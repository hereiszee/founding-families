-- Data room visit log. Run once in the Supabase SQL editor, after setup.sql.
-- Rows are written only by the room-visit edge function (service role). Admins read them in the dashboard.

create table if not exists public.room_visits (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  event       text not null,          -- open | unlock | fail | download | section
  detail      text,                   -- e.g. which PDF, which section
  visitor     text,                   -- random id stored in the visitor's browser
  ip          text,
  country     text,
  region      text,
  city        text,
  org         text,                   -- network owner, e.g. "Partner Communications"
  user_agent  text,
  referrer    text,
  lang        text,
  screen      text
);

create index if not exists room_visits_created_at_idx on public.room_visits (created_at desc);

alter table public.room_visits enable row level security;

-- No access for anon. Admins (dashboard logins) can read and delete. Inserts come from the edge function only.
drop policy if exists "admins read visits" on public.room_visits;
create policy "admins read visits" on public.room_visits
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "admins delete visits" on public.room_visits;
create policy "admins delete visits" on public.room_visits
  for delete to authenticated using (public.is_dashboard_admin());
