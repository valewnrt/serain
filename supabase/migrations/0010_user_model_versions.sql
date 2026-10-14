-- Serain: the user model is alive (D40).
-- Additive except for the move out of `agent_state`.
--
-- Until now the user model was a single text in `agent_state.user_model`, the only
-- writer was `pnpm memory:push`. Now there are versions, the newest is active.
--
-- Each version has two parts:
--   base     The owner's base text from `data/user-model.md` (memory:push). The machine
--            may only strike whole lines from it (outdated or forgotten),
--            never rewrite or extend it. The code checks that, not the model.
--   learned  What the nightly consolidation writes from new facts and the
--            summaries, with a fixed structure and a hard character cap.
--
-- Not append-only, and that is intentional: `forget_fact` must be able to erase
-- forgotten things from old versions too (W7, D13). A history that keeps deleted
-- things forever would undo the forgetting.

create table if not exists public.user_model_versions (
  id           uuid primary key default gen_random_uuid(),
  base         text not null,
  learned      text not null default '',
  source       text not null check (source in ('seed', 'push', 'consolidation', 'forget')),
  -- Consolidated up to here (created_at/updated_at of the facts).
  facts_cursor timestamptz,
  -- What changed compared to the previous version: struck lines of the
  -- base text, length before/after. No content from `learned`, that is in the row.
  diff         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists user_model_versions_created_idx
  on public.user_model_versions (created_at desc);

alter table public.user_model_versions enable row level security;

-- Markers for forgotten things (D40). Never the content: only HMAC-SHA256 of the distinctive
-- words of a deleted fact, with a key from the server env. The
-- consolidation checks its output against them, so a model does not write deleted
-- things back out of nowhere. Whoever has only the database cannot recover the words
-- without having the key.
create table if not exists public.forgotten_markers (
  id          uuid primary key default gen_random_uuid(),
  token_hmacs text[] not null,
  created_at  timestamptz not null default now()
);

alter table public.forgotten_markers enable row level security;

-- Move: the previous text becomes version 1 (source `seed`), but only once.
-- The timestamp is that of the last `memory:push`: what Serain has learned since then
-- is picked up by the first consolidation, what came before is already in the base text.
insert into public.user_model_versions (base, source, created_at)
select s.value ->> 'text', 'seed', s.updated_at
from public.agent_state s
where s.key = 'user_model'
  and coalesce(s.value ->> 'text', '') <> ''
  and not exists (select 1 from public.user_model_versions);

-- After that there is only one source. A second, outdated copy in
-- `agent_state` would be exactly the place where forgotten things survive.
delete from public.agent_state where key = 'user_model';
