-- Serain: facts for the context that do not depend on the message (memory
-- package of 2026-10-10, addendum to D6). Additive.
--
-- `search_facts` only finds what sounds like the message. Two kinds of knowledge
-- slip through:
--
-- 1. `active_situations`: what currently applies. "in lisbon from tomorrow until
--    friday" does not match "do i need a jacket?" in the vector or in the full text.
--    A situation (`kind = 'situation'`) counts if it starts at the latest at
--    `p_starts_before` (shortly before a trip it already applies for packing)
--    and either has not expired yet or, without an end, was said since
--    `p_fresh_since`: "i'm sick right now" without an end is no longer current after two
--    weeks. Newest first.
--
-- 2. `area_facts`: what a built-in playbook needs (`src/agent/playbooks.ts`),
--    from its areas (`facts.area`, 0024). Without a stored area the kind
--    counts (`p_kinds`), like `areaOf` in `src/memory/areas.ts`; which kinds those
--    are is computed by the code, not by this function. Ranked by shared
--    word stems with the playbook's keywords (counted as in
--    `search_procedures`), then by closeness to the message, then by age.
--
-- Both only for one subject key (`owner`), without superseded and without
-- expired facts, like `search_facts`.

create or replace function public.active_situations(
  p_subject text,
  p_now timestamptz,
  p_starts_before timestamptz,
  p_fresh_since timestamptz,
  p_limit integer
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
  valid_until       timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.id, f.category, f.content, f.confidence, f.source_message_id, f.created_at,
         f.kind, f.valid_from, f.valid_until
  from public.facts f
  where f.subject = p_subject
    and f.superseded_by is null
    and f.kind = 'situation'
    and (f.valid_from is null or f.valid_from <= p_starts_before)
    and (f.valid_until > p_now or (f.valid_until is null and f.created_at >= p_fresh_since))
  order by f.created_at desc, f.id
  limit greatest(p_limit, 1);
$$;

revoke all on function public.active_situations(text, timestamptz, timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.active_situations(text, timestamptz, timestamptz, timestamptz, integer)
  to service_role;

create or replace function public.area_facts(
  p_subject text,
  p_areas text[],
  p_kinds text[],
  p_embedding extensions.vector(1536),
  p_terms text,
  p_now timestamptz,
  p_limit integer
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
  shared_terms      integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with terms as (
    select coalesce(
      array(select unnest(tsvector_to_array(to_tsvector('pg_catalog.german', coalesce(p_terms, ''))))),
      '{}'::text[]
    ) as lexemes
  ),
  scored as (
    select f.id, f.category, f.content, f.confidence, f.source_message_id, f.created_at,
           f.kind, f.valid_from, f.valid_until,
           case
             when p_embedding is null or f.embedding is null then 0::real
             else (1 - (f.embedding operator(extensions.<=>) p_embedding))::real
           end as similarity,
           cardinality(array(
             select unnest(tsvector_to_array(f.content_tsv))
             intersect
             select unnest(t.lexemes)
           ))::integer as shared_terms
    from public.facts f
    cross join terms t
    where f.subject = p_subject
      and f.superseded_by is null
      and (f.valid_until is null or f.valid_until > p_now)
      and (f.area = any(p_areas) or (f.area is null and f.kind = any(p_kinds)))
  )
  select s.id, s.category, s.content, s.confidence, s.source_message_id, s.created_at,
         s.kind, s.valid_from, s.valid_until, s.similarity, s.shared_terms
  from scored s
  order by s.shared_terms desc, s.similarity desc, s.created_at desc, s.id
  limit greatest(p_limit, 1);
$$;

revoke all on function public.area_facts(text, text[], text[], extensions.vector, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.area_facts(text, text[], text[], extensions.vector, text, timestamptz, integer)
  to service_role;
