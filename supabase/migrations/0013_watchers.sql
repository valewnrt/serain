-- Serain: watchers without a model (W28, D43). Additive.
--
-- "Tell me when the price drops / the mail arrives / the page changes": fixed
-- watcher types, checked in code at the poller's pace, a model turn only on a
-- hit. No scripts that a model writes itself (D15: time bomb).
--   url_value       number after an anchor on a public page, with a comparison
--   status_changes  section after an anchor (or the page), change detected by hash
--   mail_arrives    new mail whose sender/subject matches

create table if not exists public.watchers (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('url_value', 'status_changes', 'mail_arrives')),
  -- The owner's request in one sentence, as Serain phrased it when creating it.
  label             text not null,
  -- Type-specific, validated in code with Zod (URL, anchor, comparison, sender …).
  spec              jsonb not null,
  -- Last seen value or hash. Never page or mail text.
  state             jsonb not null default '{}'::jsonb,
  status            text not null default 'active'
                    check (status in ('active', 'done', 'cancelled', 'failed', 'expired')),
  next_check_at     timestamptz not null default now(),
  last_checked_at   timestamptz,
  failures          integer not null default 0,
  expires_at        timestamptz not null,
  source_message_id uuid references public.messages (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists watchers_due_idx on public.watchers (next_check_at) where status = 'active';

alter table public.watchers enable row level security;
