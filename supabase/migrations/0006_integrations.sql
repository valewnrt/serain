-- Serain Phase 4: integrations (D7, D30, W13, W14, W16).
--
-- Additive. Same access model as everywhere: RLS on, no policy, only the
-- secret key.

-- 1) Credentials. `sealed` is the secret (app password, refresh token including
-- OAuth client), AES-256-GCM sealed with a key that exists only in the
-- server env: whoever has only the database has no access (W16). `state`
-- holds what the trigger remembers (last UID, history ID), never a secret.
create table if not exists public.integrations (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  kind        text not null check (kind in ('imap', 'google')),
  account     text not null,
  sealed      text not null,
  scopes      text[] not null default '{}',
  state       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.integrations enable row level security;
revoke all on public.integrations from anon, authenticated;

-- 2) What Serain remembers from mails (W14): one row per classified mail,
-- with a short summary and, if there is one, the commitment or appointment in it. Never
-- the mail text itself. `on delete cascade` is W13 as structure: whoever deletes the
-- credential deletes these rows with it, even if the code forgot to.
create table if not exists public.mail_items (
  id              uuid primary key default gen_random_uuid(),
  integration_id  text not null references public.integrations (id) on delete cascade,
  external_id     text not null,
  thread_key      text not null default '',
  sender          text not null default '',
  subject         text not null default '',
  received_at     timestamptz not null,
  category        text not null check (category in ('none', 'new_commitment', 'change', 'urgent')),
  summary         text not null default '',
  -- { "what": "...", "when": "..." } or null.
  commitment      jsonb,
  -- Which earlier row a change refers to.
  changes_item    uuid references public.mail_items (id) on delete set null,
  notified_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (integration_id, external_id)
);

create index if not exists mail_items_pending_idx
  on public.mail_items (created_at)
  where notified_at is null and category <> 'none';
create index if not exists mail_items_known_idx
  on public.mail_items (integration_id, received_at desc)
  where commitment is not null;

alter table public.mail_items enable row level security;
revoke all on public.mail_items from anon, authenticated;
