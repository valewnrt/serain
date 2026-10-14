-- Serain: history searchable, summaries semantic (D41). Additive.
--
-- `messages.embedding` has existed since 0001 and was never written, a dead
-- branch. From now on each turn's follow-up writes the vectors (D13: an
-- embedding costs about $0.000 000 2), and `search_messages` searches hybrid like
-- `search_facts`: vector for paraphrases, German full text for names and numbers.

alter table public.messages
  add column if not exists body_tsv tsvector
  generated always as (to_tsvector('german', body)) stored;

create index if not exists messages_body_tsv_idx on public.messages using gin (body_tsv);
create index if not exists messages_embedding_idx on public.messages
  using hnsw (embedding extensions.vector_cosine_ops);

-- Only the conversation with the owner (`p_peer`), optionally limited to a time range.
-- `taint_sources` is returned as well: what Serain wrote after foreign content,
-- the caller frames as in the history (D8.4).
create or replace function public.search_messages(
  p_peer text,
  p_embedding extensions.vector(1536),
  p_query text,
  p_limit integer,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  id            uuid,
  direction     text,
  body          text,
  created_at    timestamptz,
  taint_sources text[],
  similarity    real,
  score         real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select m.*
    from public.messages m
    where m.peer = p_peer
      and m.body <> ''
      and (p_from is null or m.created_at >= p_from)
      and (p_to is null or m.created_at < p_to)
  ),
  vector_hits as (
    select c.id,
           (1 - (c.embedding operator(extensions.<=>) p_embedding))::real as similarity,
           row_number() over (order by c.embedding operator(extensions.<=>) p_embedding) as rank
    from candidates c
    where p_embedding is not null
      and c.embedding is not null
    order by c.embedding operator(extensions.<=>) p_embedding
    limit greatest(p_limit * 2, 1)
  ),
  text_hits as (
    select c.id,
           0::real as similarity,
           row_number() over (
             order by ts_rank(c.body_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
           ) as rank
    from candidates c
    where coalesce(p_query, '') <> ''
      and c.body_tsv @@ websearch_to_tsquery('pg_catalog.german', p_query)
    order by ts_rank(c.body_tsv, websearch_to_tsquery('pg_catalog.german', p_query)) desc
    limit greatest(p_limit * 2, 1)
  ),
  merged as (
    select hits.id,
           max(hits.similarity) as similarity,
           sum(1.0 / (60 + hits.rank))::real as score
    from (select * from vector_hits union all select * from text_hits) as hits
    group by hits.id
  )
  select m.id, m.direction, m.body, m.created_at, m.taint_sources, g.similarity, g.score
  from merged g
  join public.messages m on m.id = g.id
  order by g.score desc, m.created_at desc
  limit greatest(p_limit, 1);
$$;

-- Older summaries by closeness to the message instead of only the most recent.
-- `p_before` excludes those that are already in the context as the most recent.
create or replace function public.search_summaries(
  p_embedding extensions.vector(1536),
  p_limit integer,
  p_before timestamptz default null
)
returns table (
  id            uuid,
  window_start  timestamptz,
  window_end    timestamptz,
  content       text,
  message_count integer,
  similarity    real
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.window_start, s.window_end, s.content, s.message_count,
         (1 - (s.embedding operator(extensions.<=>) p_embedding))::real as similarity
  from public.summaries s
  where p_embedding is not null
    and s.embedding is not null
    and (p_before is null or s.window_end < p_before)
  order by s.embedding operator(extensions.<=>) p_embedding
  limit greatest(p_limit, 1);
$$;

revoke all on function public.search_messages(text, extensions.vector, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.search_summaries(extensions.vector, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.search_messages(text, extensions.vector, text, integer, timestamptz, timestamptz)
  to service_role;
grant execute on function public.search_summaries(extensions.vector, integer, timestamptz)
  to service_role;
