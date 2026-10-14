-- Serain Phase 0: core schema.
-- Memory (D6), audit log and approvals (D8), scheduler (D9), budget guard (D3).
-- Additive. Access only from the server with the secret key; RLS is on everywhere
-- and there is deliberately no policy, so anon/authenticated see nothing.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- 1) Messages: every inbound and outbound message, with channel ID for dedupe.
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null default 'photon',
  direction     text not null check (direction in ('inbound', 'outbound')),
  external_id   text not null default '',
  chat_id       text not null default '',
  peer          text not null,
  is_group      boolean not null default false,
  body          text not null default '',
  attachments   jsonb not null default '[]'::jsonb,
  raw           jsonb,
  embedding     extensions.vector(1536),
  created_at    timestamptz not null default now()
);

-- Dedupe: the same channel message may exist only once.
create unique index if not exists messages_channel_external_id_key
  on public.messages (channel, external_id)
  where external_id <> '';

create index if not exists messages_created_at_idx on public.messages (created_at desc);
create index if not exists messages_peer_idx on public.messages (peer, created_at desc);

-- 2) Facts with provenance. A correction replaces (superseded_by), it does not delete.
create table if not exists public.facts (
  id                uuid primary key default gen_random_uuid(),
  subject           text not null default 'owner',
  category          text not null,
  content           text not null,
  confidence        real not null default 0.8 check (confidence >= 0 and confidence <= 1),
  source_message_id uuid references public.messages (id) on delete set null,
  superseded_by     uuid references public.facts (id) on delete set null,
  embedding         extensions.vector(1536),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists facts_active_idx on public.facts (subject, category) where superseded_by is null;

-- 3) Rolling summaries for building the context of each turn.
create table if not exists public.summaries (
  id            uuid primary key default gen_random_uuid(),
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  content       text not null,
  message_count integer not null default 0,
  embedding     extensions.vector(1536),
  created_at    timestamptz not null default now()
);

create index if not exists summaries_window_idx on public.summaries (window_end desc);

-- 4) Scheduler: one-off and recurring jobs, 30 s poller.
create table if not exists public.schedules (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('once', 'cron')),
  cron_expr    text,
  next_run_at  timestamptz not null,
  prompt       text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts     integer not null default 0,
  last_run_at  timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint schedules_cron_expr_required check (kind <> 'cron' or cron_expr is not null)
);

create index if not exists schedules_due_idx on public.schedules (next_run_at) where status = 'pending';

-- 5) Audit log: append-only. Every message, every tool call, every refusal.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  event       text not null,
  actor       text not null default 'serain',
  message_id  uuid references public.messages (id) on delete set null,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_event_idx on public.audit_log (event, at desc);

-- Immutable: no update, no delete, not even with the secret key.
create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit_log ist append-only (% nicht erlaubt)', tg_op;
end;
$$;

drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

-- 6) Approvals for the tool levels irreversible and money (D8.3).
create table if not exists public.approvals (
  id                  uuid primary key default gen_random_uuid(),
  tool                text not null,
  level               text not null check (level in ('irreversible', 'money')),
  args                jsonb not null default '{}'::jsonb,
  preview             text not null,
  token               text not null unique,
  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'denied', 'expired')),
  requested_at        timestamptz not null default now(),
  expires_at          timestamptz not null,
  decided_at          timestamptz,
  decided_via         text,
  request_message_id  uuid references public.messages (id) on delete set null,
  decision_message_id uuid references public.messages (id) on delete set null
);

create index if not exists approvals_pending_idx on public.approvals (expires_at) where status = 'pending';

-- 7) Budget guard: model costs and channel messages in the same log.
create table if not exists public.usage_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  kind          text not null check (kind in ('model', 'channel_message')),
  provider      text not null,
  model         text,
  role          text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  units         integer not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  detail        jsonb not null default '{}'::jsonb
);

create index if not exists usage_log_at_idx on public.usage_log (at desc);

-- Monthly totals for the budget cap.
create or replace view public.usage_month as
select
  date_trunc('month', at) as month,
  provider,
  kind,
  sum(cost_usd)::numeric(12, 6) as cost_usd,
  sum(units)::bigint as units,
  sum(input_tokens)::bigint as input_tokens,
  sum(output_tokens)::bigint as output_tokens
from public.usage_log
group by 1, 2, 3;

-- 8) Runtime state that must survive a restart (kill switch, sync cursor).
create table if not exists public.agent_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS on everywhere, deliberately without a policy: only the server's secret key gets through.
alter table public.messages    enable row level security;
alter table public.facts       enable row level security;
alter table public.summaries   enable row level security;
alter table public.schedules   enable row level security;
alter table public.audit_log   enable row level security;
alter table public.approvals   enable row level security;
alter table public.usage_log   enable row level security;
alter table public.agent_state enable row level security;

revoke all on public.usage_month from anon, authenticated;
