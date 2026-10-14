-- Serain health check and incident log (W11, D10 "health check cron still pending").
-- Additive, same access model as 0001_core.sql: RLS on, no policy, only the
-- server's secret key gets through (main process and watchdog script run with
-- the same key, see src/health/).

-- 1) Heartbeat: one row per component, kept current via upsert.
-- `model` is informational only (last successful model call); only what should
-- run continuously is monitored (process, channel, db), see
-- MONITORED_COMPONENTS in src/health/status.ts.
create table if not exists public.component_status (
  component   text primary key check (component in ('process', 'channel', 'db', 'model')),
  status      text not null check (status in ('ok', 'degraded', 'down')),
  last_ok_at  timestamptz,
  detail      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 2) Incidents: append-friendly. Insert on open, one update on close
-- (no append-only trigger like audit_log: closing is a legitimate update,
-- not a forgery of an audit entry; any message to the owner about it ends up
-- in messages/audit_log anyway via the normal send path).
create table if not exists public.incidents (
  id          uuid primary key default gen_random_uuid(),
  component   text not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  root_cause  text,
  note        text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- At most one open incident per component. Prevents duplicates when the
-- watchdog and the main process both detect an outage in the same time window.
create unique index if not exists incidents_open_per_component_idx
  on public.incidents (component)
  where ended_at is null;

create index if not exists incidents_component_idx on public.incidents (component, started_at desc);

alter table public.component_status enable row level security;
alter table public.incidents        enable row level security;
