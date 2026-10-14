-- Serain: monthly totals from usage_log in the database (D3, addendum of 2026-10-08). Additive.
--
-- Live finding in the self-test for package 2: the budget guard summed the month's rows
-- in the client, but PostgREST returns at most 1,000 rows. On 2026-10-08 there were
-- 2,184 model calls in the month; $0.41 was counted instead of $0.97. From about the
-- fourth day of a month the cap therefore saw only part of the costs, since
-- phase 0. The search quota had the same trap. Postgres now computes the sum.

create or replace function public.usage_since(p_kind text, p_since timestamptz)
returns table (cost_usd numeric, units bigint)
language sql
stable
set search_path = public
as $$
  select coalesce(sum(u.cost_usd), 0), coalesce(sum(u.units), 0)::bigint
  from public.usage_log u
  where u.kind = p_kind and u.at >= p_since;
$$;

revoke all on function public.usage_since(text, timestamptz) from public, anon, authenticated;
grant execute on function public.usage_since(text, timestamptz) to service_role;
