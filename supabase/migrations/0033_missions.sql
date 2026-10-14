-- Serain: missions over days (D63, building block B). Additive.
--
-- What runs over days (requests with a deadline, follow-ups, complaints) was
-- held together by nobody so far: a turn has eight steps, a task eight minutes.
-- A mission has a goal (from the owner, created in a clean turn), a
-- history of notes, and is woken via `schedules` (kind `mission` in `payload`).
--
-- Every note carries the provenance of the turn that wrote it (D8.4): a note
-- after a reply mail is derived from foreign content and is treated as such when waking
-- and displaying. Forgetting deletes hard, notes included (W7).
create table if not exists public.missions (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 3 and 80),
  goal        text not null check (char_length(goal) between 10 and 1500),
  status      text not null default 'active' check (status in ('active', 'done', 'cancelled')),
  outcome     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz
);

create index if not exists missions_active_idx on public.missions (created_at) where status = 'active';

create table if not exists public.mission_notes (
  id             bigint generated always as identity primary key,
  mission_id     uuid not null references public.missions (id) on delete cascade,
  at             timestamptz not null default now(),
  text           text not null check (char_length(text) between 1 and 800),
  taint_sources  text[] not null default '{}',
  origin         text not null
);

create index if not exists mission_notes_mission_idx on public.mission_notes (mission_id, at);

alter table public.missions enable row level security;
alter table public.mission_notes enable row level security;
revoke all on public.missions, public.mission_notes from anon, authenticated;
