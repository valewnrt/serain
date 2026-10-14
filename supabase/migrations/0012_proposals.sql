-- Serain: proposals the owner confirms, and approved procedures (D42).
-- Additive.
--
-- Two kinds, one path: Serain proposes, the owner says 👍 (all), 👎 (none) or
-- replies in the thread with the numbers. Evaluated in code, before the model (D14).
--   lesson     from a 👎 and the correction after it. Once confirmed it becomes a
--              fact (kind `preference`, category `stil`). Collected, asked weekly.
--   procedure  a procedure after a successful multi-step task. Once confirmed
--              it lands in `procedures` and is shown when a task
--              fits: as a hint to the model, never as a permission.

create table if not exists public.memory_proposals (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('lesson', 'procedure')),
  title                 text not null default '',
  body                  text not null,
  -- Only `procedure`: how to recognize a fitting task.
  trigger               text not null default '',
  status                text not null default 'pending'
                        check (status in ('pending', 'offered', 'accepted', 'rejected', 'expired')),
  -- Channel ID of the message Serain asked with. 👍 and thread replies attach to it.
  offer_external_id     text,
  -- The Serain message the owner's 👎 was on (lesson), or the triggering message (procedure).
  source_message_id     uuid references public.messages (id) on delete set null,
  -- The owner's correction (lesson).
  correction_message_id uuid references public.messages (id) on delete set null,
  -- Foreign content the proposal is derived from (D8.4). Carried over to the question to the owner.
  taint_sources         text[] not null default '{}',
  created_at            timestamptz not null default now(),
  offered_at            timestamptz,
  decided_at            timestamptz
);

create index if not exists memory_proposals_pending_idx
  on public.memory_proposals (kind, created_at) where status = 'pending';
create index if not exists memory_proposals_offer_idx
  on public.memory_proposals (offer_external_id) where status = 'offered';

alter table public.memory_proposals enable row level security;

create table if not exists public.procedures (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  trigger     text not null,
  embedding   extensions.vector(1536),
  search_tsv  tsvector generated always as (to_tsvector('german', title || ' ' || trigger)) stored,
  proposal_id uuid references public.memory_proposals (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists procedures_search_tsv_idx on public.procedures using gin (search_tsv);

alter table public.procedures enable row level security;
