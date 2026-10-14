-- Serain: find approved procedures when a task fits (D42).
-- Additive.
--
-- `procedures` comes from 0012 with an embedding and German full text over title
-- and recognition trigger. Search is hybrid as with `search_facts`, but with
-- a different result: not a ranking that always returns something, but
-- two raw values the code applies a threshold to. A procedure should only be in the
-- context when it really fits, not the best of twenty in every
-- turn.
--
--   similarity    cosine similarity, 0 without an embedding.
--   shared_terms  shared German word stems between the message and
--                 title plus recognition trigger. Deliberately counted instead of using
--                 `websearch_to_tsquery`: that requires every word of the message
--                 and would never match on a whole sentence.
--
-- No vector index: there are at most 20 procedures (`PROPOSALS.maxActiveProcedures`),
-- an index would be slower than the scan.
create or replace function public.search_procedures(
  p_embedding extensions.vector(1536),
  p_query text,
  p_limit integer
)
returns table (
  id           uuid,
  title        text,
  body         text,
  trigger      text,
  proposal_id  uuid,
  created_at   timestamptz,
  similarity   real,
  shared_terms integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with query_terms as (
    select coalesce(
      array(select unnest(tsvector_to_array(to_tsvector('pg_catalog.german', coalesce(p_query, ''))))),
      '{}'::text[]
    ) as lexemes
  ),
  scored as (
    select p.id, p.title, p.body, p.trigger, p.proposal_id, p.created_at,
           case
             when p_embedding is null or p.embedding is null then 0::real
             else (1 - (p.embedding operator(extensions.<=>) p_embedding))::real
           end as similarity,
           cardinality(array(
             select unnest(tsvector_to_array(p.search_tsv))
             intersect
             select unnest(q.lexemes)
           ))::integer as shared_terms
    from public.procedures p
    cross join query_terms q
  )
  select s.id, s.title, s.body, s.trigger, s.proposal_id, s.created_at, s.similarity, s.shared_terms
  from scored s
  order by s.similarity desc, s.shared_terms desc, s.created_at desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.search_procedures(extensions.vector, text, integer)
  from public, anon, authenticated;
grant execute on function public.search_procedures(extensions.vector, text, integer)
  to service_role;
