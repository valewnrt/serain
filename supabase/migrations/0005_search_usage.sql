-- Serain Phase 2: web search in the budget guard (D3, D16).
--
-- Additive. `usage_log` only knew model calls and channel messages. Search
-- runs through a provider with a monthly quota on the free tier; it is counted
-- in the same place as everything else that has a quota.
alter table public.usage_log drop constraint if exists usage_log_kind_check;
alter table public.usage_log add constraint usage_log_kind_check
  check (kind in ('model', 'channel_message', 'search'));
