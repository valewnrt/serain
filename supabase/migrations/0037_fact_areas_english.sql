-- Serain: English keys for the memory areas. Additive.
--
-- `src/memory/areas.ts` now writes `self`, `open`, `people`, `places`,
-- `preferences` and `anniversaries` instead of the German keys from 0024
-- (`ich`, `offen`, `personen`, `orte`, `praeferenzen`, `jahrestage`). The
-- check accepts both, so rows written before this migration stay valid and
-- code that still reads them maps them through `areaFromStored`. Existing rows
-- are moved to the new keys. `updated_at` is left alone on purpose: the area is
-- a label for grouping, not a change to the fact.

alter table public.facts drop constraint if exists facts_area_check;
alter table public.facts
  add constraint facts_area_check
  check (area is null or area in (
    'self', 'open', 'people', 'places', 'preferences', 'anniversaries',
    'ich', 'offen', 'personen', 'orte', 'praeferenzen', 'jahrestage'
  ));

update public.facts
set area = case area
  when 'ich' then 'self'
  when 'offen' then 'open'
  when 'personen' then 'people'
  when 'orte' then 'places'
  when 'praeferenzen' then 'preferences'
  when 'jahrestage' then 'anniversaries'
end
where area in ('ich', 'offen', 'personen', 'orte', 'praeferenzen', 'jahrestage');
