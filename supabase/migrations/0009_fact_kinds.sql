-- Serain: kind and validity of facts (D39).
-- Additive.
--
-- A fact now knows what it is:
--   identity   who the owner is (place of residence, job, people around them), stable
--   preference what they like, how they work, habits
--   situation  what currently applies and is ongoing ("exam period until end of October")
--   episode    a one-off event with a date that still matters later
-- and when it applies. `valid_from` in the future means "from then on" (the gate failure case
-- "from next month …" from D13), `valid_until` in the past means
-- expired: recall no longer shows it, the nightly consolidation removes
-- it from the user model.
--
-- Existing facts (seed from `memory:push` and everything the write path has
-- learned up to here) get `identity` without expiry. That is not a classification,
-- but the state before this migration: so far they applied indefinitely, and that
-- stays so. `data/facts.json` can add the kind per fact later.

alter table public.facts
  add column if not exists kind text not null default 'identity';
alter table public.facts
  add column if not exists valid_from timestamptz;
alter table public.facts
  add column if not exists valid_until timestamptz;

alter table public.facts drop constraint if exists facts_kind_check;
alter table public.facts
  add constraint facts_kind_check check (kind in ('identity', 'preference', 'situation', 'episode'));

alter table public.facts drop constraint if exists facts_validity_order;
alter table public.facts
  add constraint facts_validity_order
  check (valid_from is null or valid_until is null or valid_from < valid_until);

-- For the consolidation's pre-check: what has expired since the last run?
create index if not exists facts_valid_until_idx on public.facts (valid_until)
  where superseded_by is null and valid_until is not null;

-- Recall with a clock. The signature changes (kind, validity, point in time), so
-- the old version goes first; `create or replace` cannot change the return type.
--
-- `text_hit` says whether full text matched. The memory eval (D45) showed
-- that a hit from full text plus a weak vector (0.52) used to fail at
-- the similarity threshold: "forget the thing about Defne" found nothing,
-- although the name is in the fact.
--
-- `p_now` is a parameter instead of `now()`, so eval and tests with a set clock
-- run the same function as production. Expired facts drop out;
-- `p_include_expired` brings them back for `forget_fact`: the owner must be able
-- to have something expired deleted too. Facts that only apply in the future
-- stay in and carry `valid_from`, so Serain can say "from the 1st".
drop function if exists public.search_facts(text, extensions.vector, text, integer);
drop function if exists public.search_facts(text, extensions.vector, text, integer, timestamptz, boolean);

create function public.search_facts(
  p_subject text,
  p_embedding extensions.vector(1536),
  p_query text,
  p_limit integer,
  p_now timestamptz default now(),
  p_include_expired boolean default false
)
returns table (
  id                uuid,
  category          text,
  content           text,
  confidence        real,
  source_message_id uuid,
  created_at        timestamptz,
  kind              text,
  valid_from        timestamptz,
  valid_until       timestamptz,
  similarity        real,
  score             real,
  text_hit          boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select f.*
    from public.facts f
    where f.subject = p_subject
      and f.superseded_by is null
      and (p_include_expired or f.valid_until is null or f.valid_until > p_now)
  ),
  vector_hits as (
    select c.id,
           (1 - (c.embedding operator(extensions.<=>) p_embedding))::real as similarity,
           row_number() over (order by c.embedding operator(extensions.<=>) p_embedding) as rank
    from candidates c
    where p_embedding is not null
      and c.embedding is not null
    order by c.embedding operator(extensions.<=>) p_embedding
    limit greatest(p_limit, 1)
  ),
  text_hits as (
    select c.id,
           0::real as similarity,
           row_number() over (
             order by ts_rank(c.content_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
           ) as rank
    from candidates c
    where coalesce(p_query, '') <> ''
      and c.content_tsv @@ websearch_to_tsquery('pg_catalog.german', p_query)
    order by ts_rank(c.content_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
    limit greatest(p_limit, 1)
  ),
  merged as (
    select hits.id,
           max(hits.similarity) as similarity,
           sum(1.0 / (60 + hits.rank))::real as score
    from (select * from vector_hits union all select * from text_hits) as hits
    group by hits.id
  )
  select f.id,
         f.category,
         f.content,
         f.confidence,
         f.source_message_id,
         f.created_at,
         f.kind,
         f.valid_from,
         f.valid_until,
         m.similarity,
         m.score,
         exists (select 1 from text_hits t where t.id = m.id) as text_hit
  from merged m
  join public.facts f on f.id = m.id
  order by m.score desc, f.created_at desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.search_facts(text, extensions.vector, text, integer, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.search_facts(text, extensions.vector, text, integer, timestamptz, boolean)
  to service_role;

-- Forgetting also removes summaries from the time window of **every** version,
-- not only the newest (finding from the memory eval, D45: a summary
-- about the first version survived). Otherwise as 0003.
create or replace function public.forget_fact(p_id uuid)
returns table (deleted_ids uuid[], categories text[], summaries_deleted integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids        uuid[];
  v_contents   text[];
  v_categories text[];
  v_summaries  integer := 0;
begin
  select array_agg(c.id), array_agg(c.content), array_agg(c.category)
  into v_ids, v_contents, v_categories
  from (
    with recursive chain as (
      select f.id, f.content, f.category
      from public.facts f
      where f.id = p_id
      union all
      select f.id, f.content, f.category
      from public.facts f
      join chain ch on f.superseded_by = ch.id
    )
    select chain.id, chain.content, chain.category from chain
  ) as c;

  if v_ids is null then
    return query select '{}'::uuid[], '{}'::text[], 0;
    return;
  end if;

  with sources as (
    select m.created_at
    from public.messages m
    join public.facts f on f.source_message_id = m.id
    where f.id = any(v_ids)
  ),
  gone as (
    delete from public.summaries s
    where exists (select 1 from sources src where s.window_start <= src.created_at and s.window_end >= src.created_at)
       or exists (select 1 from unnest(v_contents) as c(fact_text) where s.content like '%' || c.fact_text || '%')
    returning 1
  )
  select count(*)::integer into v_summaries from gone;

  delete from public.facts f where f.id = any(v_ids);

  return query select v_ids, v_categories, v_summaries;
end;
$$;

revoke all on function public.forget_fact(uuid) from public, anon, authenticated;
grant execute on function public.forget_fact(uuid) to service_role;
