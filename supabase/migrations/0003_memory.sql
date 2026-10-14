-- Serain Memory v1 (D6, D12, D13): recall via pgvector plus full text, open
-- follow-up questions on fact conflicts, real deletion.
--
-- Additive, same access model as 0001_core.sql: RLS on, deliberately no
-- policy, only the server's secret key gets through. The functions run as
-- `security invoker`: they should not grant rights the caller does not
-- already have; anon and authenticated do not get them at all.

-- 1) Full text next to the vector. An embedding finds paraphrases, a
-- full-text hit finds proper names and numbers that an embedding
-- misses ("house number 14"). Hence both, not one of them.
alter table public.facts
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('german', content)) stored;

create index if not exists facts_content_tsv_idx on public.facts using gin (content_tsv);

-- 2) HNSW on the active facts. Partial, because superseded facts are never
-- searched: the index stays as small as what Serain actually knows.
create index if not exists facts_embedding_idx on public.facts
  using hnsw (embedding extensions.vector_cosine_ops)
  where superseded_by is null;

create index if not exists summaries_embedding_idx on public.summaries
  using hnsw (embedding extensions.vector_cosine_ops);

-- 3) Open follow-up questions (W20). When a new fact might replace an old one,
-- but only might, nothing is silently overwritten. Both facts stay and the
-- conflict is queued here; Serain asks the question at the next fitting
-- turn, provided it is important enough.
create table if not exists public.open_questions (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'fact_conflict' check (kind in ('fact_conflict')),
  question      text not null,
  fact_id       uuid not null references public.facts (id) on delete cascade,
  rival_fact_id uuid not null references public.facts (id) on delete cascade,
  /** Expected value on the importance scale, 0-indexed (see src/memory). */
  importance    real not null default 0,
  status        text not null default 'open' check (status in ('open', 'asked', 'resolved')),
  created_at    timestamptz not null default now(),
  asked_at      timestamptz,
  resolved_at   timestamptz
);

-- The same conflict is queued only once.
create unique index if not exists open_questions_pair_idx
  on public.open_questions (fact_id, rival_fact_id)
  where status <> 'resolved';

create index if not exists open_questions_open_idx
  on public.open_questions (importance desc, created_at)
  where status = 'open';

alter table public.open_questions enable row level security;

-- 4) Recall: vector and full-text search in one call, merged via
-- Reciprocal Rank Fusion. RRF instead of added scores, because cosine similarity
-- and ts_rank are not on the same scale; if you add them, the vector side
-- always wins. `similarity` is returned as well, so the caller can apply a real
-- similarity threshold for the conflict search.
create or replace function public.search_facts(
  p_subject text,
  p_embedding extensions.vector(1536),
  p_query text,
  p_limit integer
)
returns table (
  id                uuid,
  category          text,
  content           text,
  confidence        real,
  source_message_id uuid,
  created_at        timestamptz,
  similarity        real,
  score             real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vector_hits as (
    select f.id,
           (1 - (f.embedding operator(extensions.<=>) p_embedding))::real as similarity,
           row_number() over (order by f.embedding operator(extensions.<=>) p_embedding) as rank
    from public.facts f
    where f.subject = p_subject
      and f.superseded_by is null
      and p_embedding is not null
      and f.embedding is not null
    order by f.embedding operator(extensions.<=>) p_embedding
    limit greatest(p_limit, 1)
  ),
  text_hits as (
    select f.id,
           0::real as similarity,
           row_number() over (
             order by ts_rank(f.content_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
           ) as rank
    from public.facts f
    where f.subject = p_subject
      and f.superseded_by is null
      and coalesce(p_query, '') <> ''
      and f.content_tsv @@ websearch_to_tsquery('pg_catalog.german', p_query)
    order by ts_rank(f.content_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
    limit greatest(p_limit, 1)
  ),
  merged as (
    select hits.id,
           max(hits.similarity) as similarity,
           -- 60 is the usual damping: the first hit should lead, but
           -- a second hit in the other list should still count.
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
         m.similarity,
         m.score
  from merged m
  join public.facts f on f.id = m.id
  order by m.score desc, f.created_at desc
  limit greatest(p_limit, 1);
$$;

-- 5) Forgetting (W7). Hard, in one transaction, with the whole replacement chain:
-- deleting only the current fact revives the old version via
-- `superseded_by = null`, so "forget my address" would bring back the previous address.
--
-- Also gone: summaries whose time window contains the source message,
-- and summaries that contain the wording. Not gone (and this is
-- the honest limit): the source message in `messages`. It is the owner's
-- own chat history; deleting it would falsify the record and break
-- channel dedupe. As long as it is within the history window, Serain can
-- read it, as a message, not as memory.
create or replace function public.forget_fact(p_id uuid)
returns table (deleted_ids uuid[], categories text[], summaries_deleted integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids       uuid[];
  v_contents  text[];
  v_categories text[];
  v_msg_at    timestamptz;
  v_summaries integer := 0;
begin
  -- The chain as a subquery instead of a leading WITH: this way the INTO
  -- clearly belongs to the outer SELECT and not to a CTE.
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

  select m.created_at into v_msg_at
  from public.messages m
  join public.facts f on f.source_message_id = m.id
  where f.id = p_id;

  with gone as (
    delete from public.summaries s
    where (v_msg_at is not null and s.window_start <= v_msg_at and s.window_end >= v_msg_at)
       or exists (select 1 from unnest(v_contents) as c(fact_text) where s.content like '%' || c.fact_text || '%')
    returning 1
  )
  select count(*)::integer into v_summaries from gone;

  delete from public.facts f where f.id = any(v_ids);

  return query select v_ids, v_categories, v_summaries;
end;
$$;

-- 6) Privileges. Postgres gives **PUBLIC** EXECUTE on every new function by
-- default; a `revoke … from anon, authenticated` alone therefore has no effect
-- as long as PUBLIC still has the privilege. So revoke from PUBLIC first, then
-- grant to the one caller that really needs the functions: the server with
-- the secret key (`service_role`). The owner of the functions keeps them
-- anyway. Naming anon and authenticated as well also removes the
-- explicit grants that Supabase hands out via `alter default privileges`.
revoke all on function public.search_facts(text, extensions.vector, text, integer)
  from public, anon, authenticated;
revoke all on function public.forget_fact(uuid) from public, anon, authenticated;

grant execute on function public.search_facts(text, extensions.vector, text, integer) to service_role;
grant execute on function public.forget_fact(uuid) to service_role;
