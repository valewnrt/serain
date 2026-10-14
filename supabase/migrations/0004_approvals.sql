-- Serain Phase 2: approval protocol (D8.3, D14, W1, W4).
--
-- Additive. `approvals` exists since 0001_core.sql, but without the link to the
-- preview message, without scope and without execution status. Same
-- access model as everywhere: RLS on, no policy, only the secret key.

-- 1) Link to the preview. A 👍 or a "ja" in the thread carries the channel ID of the
-- preview message; the approval is matched through that, not through text.
alter table public.approvals
  add column if not exists preview_external_id text not null default '',
  add column if not exists undo text not null default '',
  add column if not exists grant_key text not null default '',
  add column if not exists scope text not null default 'once',
  add column if not exists executed_at timestamptz,
  add column if not exists result jsonb;

-- At most one open approval per preview message.
create unique index if not exists approvals_preview_pending_idx
  on public.approvals (preview_external_id)
  where status = 'pending' and preview_external_id <> '';

-- 2) Status now also covers execution. `approved` means: the owner has
-- agreed and execution is running; afterwards `executed` or `failed`. An
-- entry that stays at `approved` after a crash is not
-- retried: an irreversible action had better not run at all than run twice.
alter table public.approvals drop constraint if exists approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed'));

alter table public.approvals drop constraint if exists approvals_scope_check;
alter table public.approvals add constraint approvals_scope_check
  check (scope in ('once', 'standing'));

-- 3) Standing approvals (W4): "ja immer" applies to exactly this tool and exactly this
-- task type (`grant_key`, e.g. the recipient), until the owner revokes it. For money
-- this never exists: no standing approval for money. That
-- is a check here, so it is not only in the code.
create table if not exists public.approval_grants (
  id           uuid primary key default gen_random_uuid(),
  tool         text not null,
  grant_key    text not null default '',
  level        text not null check (level = 'irreversible'),
  approval_id  uuid references public.approvals (id) on delete set null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_via  text
);

create unique index if not exists approval_grants_active_idx
  on public.approval_grants (tool, grant_key)
  where revoked_at is null;

alter table public.approval_grants enable row level security;
