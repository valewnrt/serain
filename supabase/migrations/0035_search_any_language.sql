-- Serain: full-text search in any language. Additive.
--
-- Until now every full-text column and query used the `german` configuration:
-- German stems and stop words on facts (0003, 0009, 0028), the chat history
-- (0011) and procedures (0012, 0015). For an owner who writes Turkish or
-- Spanish that is wrong, not just weaker: the German stemmer cuts foreign words
-- at German suffixes, and German stop words are the only ones removed.
--
-- The new configuration `serain_text` stems nothing. It lowercases words like
-- `simple` and only drops English and German stop words (the two languages
-- Serain has built in), so a query such as "the sister of Defne" or
-- "die Schwester von Defne" still requires only the words that carry meaning,
-- as it did with `german`. In every other language it behaves exactly like
-- `simple`. Full text is there for names and numbers that an embedding misses
-- ("house number 14"); inflected forms, synonyms and other languages are the
-- embedding's job.
--
-- What changes:
--   facts.content_tsv, messages.body_tsv, procedures.search_tsv
--       regenerated with `serain_text` (dropped and added again, because
--       `alter column ... set expression` needs Postgres 17), indexes rebuilt.
--   search_facts, search_messages, search_procedures, area_facts
--       same signature and result, queries parsed with `serain_text`.
--
-- Idempotent: the dictionaries and the configuration are created only once,
-- a column is rebuilt only while its expression does not use `serain_text` yet.

-- 1) Stop-word filters and the configuration.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_ts_dict d
    join pg_catalog.pg_namespace n on n.oid = d.dictnamespace
    where n.nspname = 'public' and d.dictname = 'serain_english_stop'
  ) then
    create text search dictionary public.serain_english_stop (
      template = pg_catalog.simple, stopwords = english, accept = false
    );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_ts_dict d
    join pg_catalog.pg_namespace n on n.oid = d.dictnamespace
    where n.nspname = 'public' and d.dictname = 'serain_german_stop'
  ) then
    create text search dictionary public.serain_german_stop (
      template = pg_catalog.simple, stopwords = german, accept = false
    );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_ts_config c
    join pg_catalog.pg_namespace n on n.oid = c.cfgnamespace
    where n.nspname = 'public' and c.cfgname = 'serain_text'
  ) then
    create text search configuration public.serain_text (copy = pg_catalog.simple);
    -- A stop word ends in the first or second filter (`accept = false` passes
    -- every other word on); `simple` takes the rest, lowercased and unstemmed.
    alter text search configuration public.serain_text
      alter mapping for asciiword, word, numword, asciihword, hword, numhword,
                        hword_asciipart, hword_part, hword_numpart
      with public.serain_english_stop, public.serain_german_stop, pg_catalog.simple;
  end if;
end
$$;

-- 2) Generated columns. A column is rebuilt only while its expression does not
-- mention `serain_text`, so a second run leaves the tables alone.
do $$
declare
  target record;
begin
  for target in
    select *
    from (values
      ('facts', 'content_tsv', 'content', 'facts_content_tsv_idx'),
      ('messages', 'body_tsv', 'body', 'messages_body_tsv_idx'),
      ('procedures', 'search_tsv', $expr$title || ' ' || trigger$expr$, 'procedures_search_tsv_idx')
    ) as t(tbl, col, source, idx)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = format('public.%I', target.tbl)::regclass
        and a.attname = target.col
        and not a.attisdropped
        and pg_catalog.pg_get_expr(d.adbin, d.adrelid) like '%serain_text%'
    ) then
      execute format('alter table public.%I drop column if exists %I', target.tbl, target.col);
      execute format(
        'alter table public.%I add column %I tsvector generated always as (to_tsvector(%L::regconfig, %s)) stored',
        target.tbl, target.col, 'public.serain_text', target.source
      );
      execute format('create index if not exists %I on public.%I using gin (%I)', target.idx, target.tbl, target.col);
    end if;
  end loop;
end
$$;

-- 3) The search functions, unchanged apart from the configuration. Bodies as in
-- 0009 (search_facts), 0011 (search_messages), 0015 (search_procedures) and
-- 0028 (area_facts); `create or replace` with the same signature keeps the
-- grants.
create or replace function public.search_facts(
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
             order by ts_rank(c.content_tsv, websearch_to_tsquery('public.serain_text', p_query)) desc
           ) as rank
    from candidates c
    where coalesce(p_query, '') <> ''
      and c.content_tsv @@ websearch_to_tsquery('public.serain_text', p_query)
    order by ts_rank(c.content_tsv, websearch_to_tsquery('public.serain_text', p_query)) desc
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
             order by ts_rank(c.body_tsv, websearch_to_tsquery('public.serain_text', p_query)) desc
           ) as rank
    from candidates c
    where coalesce(p_query, '') <> ''
      and c.body_tsv @@ websearch_to_tsquery('public.serain_text', p_query)
    order by ts_rank(c.body_tsv, websearch_to_tsquery('public.serain_text', p_query)) desc
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

-- `shared_terms` now counts shared words (lowercased, English and German stop
-- words left out) instead of German stems.
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
      array(select unnest(tsvector_to_array(to_tsvector('public.serain_text', coalesce(p_query, ''))))),
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
      array(select unnest(tsvector_to_array(to_tsvector('public.serain_text', coalesce(p_terms, ''))))),
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
