-- Serain: package 2 of 2026-10-08 (addendum to D6, D49). Additive.
--
-- 1. Areas for the memory. `show_memory` groups by me, open,
--    people, places, preferences and anniversaries. That cannot be read from
--    the free category (the birthday is under "identität", and so is the
--    address), so every fact carries an area. Null means: not yet
--    assigned; extraction sets it when writing, maintenance assigns
--    older ones afterwards (`src/memory/areas.ts`).
--
-- 2. The audit in the web interface knows `give_feedback` (event `feedback`, its own
--    category, as a list under Audit → Feedback) and `overview`, which replaces the
--    tools `list_schedules` and `watch_list`. Both read tools
--    stay invisible in the audit as before; so does the `give_feedback` call,
--    because the `feedback` event already shows it. The event for the owner's 👎 and ❓
--    is now called `reaction_feedback` and was never in the web interface. Otherwise
--    unchanged from 0022_vault_files.sql.

alter table public.facts
  add column if not exists area text;

alter table public.facts drop constraint if exists facts_area_check;
alter table public.facts
  add constraint facts_area_check
  check (area is null or area in ('ich', 'offen', 'personen', 'orte', 'praeferenzen', 'jahrestage'));

-- For maintenance: what is not assigned yet?
create index if not exists facts_area_missing_idx on public.facts (created_at)
  where superseded_by is null and area is null;

create or replace view public.web_audit as
  with surface(tool) as (
    values ('send_message'), ('reply_in_thread'), ('react'), ('edit_message'), ('end_turn'),
           ('cancel_silently'), ('show_memory'), ('list_schedules'), ('watch_list'), ('overview'), ('finish_task'),
           ('web_search'), ('web_fetch'), ('web_browse'), ('run_code'), ('mac_browser'),
           ('site_look'), ('site_act'), ('confirm_selftest'), ('vault_files'), ('give_feedback')
  ),
  picked as (
    select a.*
    from public.audit_log a
    where a.actor in ('serain', 'web')
      and (
        (a.event in ('tool_call', 'tool_denied')
          and not exists (select 1 from surface s where s.tool = a.detail ->> 'tool'))
        or a.event in (
          'inbound_rejected', 'kill_switch', 'kill_switch_release',
          'approval_requested', 'approval_decided', 'approval_denied', 'approval_expired',
          'approval_grant', 'approval_grant_used', 'approval_waived', 'approval_revoked', 'approval_interrupted',
          'integration_connected', 'integration_disconnected',
          'connector_requested', 'connector_connected', 'connector_failed', 'connector_disconnect_requested', 'connector_disconnected',
          'vault_saved', 'vault_deleted', 'vault_file_saved', 'vault_file_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
          'budget_warning', 'selftest',
          'task_finished', 'task_cancelled', 'task_interrupted', 'schedule_fired', 'schedule_failed',
          'turn_recovered', 'turn_abandoned',
          'memory_forget', 'memory_user_model',
          'error', 'outbound_failed', 'channel_disconnected', 'delivery_health',
          'feedback'
        )
        or (a.event = 'memory_fact' and a.detail ? 'fact_id')
        or (a.event = 'memory_consolidation' and a.detail ->> 'ran' = 'true')
        or (a.event = 'memory_proposal' and a.detail ->> 'action' in ('created', 'offered'))
        or (a.event = 'watcher' and a.detail ->> 'action' in ('cancelled', 'failed', 'expired'))
        or (a.event = 'mail_trigger' and a.detail ->> 'reason' = 'error')
      )
  )
  select
    p.id,
    p.at,
    p.event,
    case
      when p.event = 'feedback' then 'feedback'
      when p.event in (
        'inbound_rejected', 'kill_switch', 'kill_switch_release', 'tool_denied',
        'approval_requested', 'approval_decided', 'approval_denied', 'approval_expired',
        'approval_grant', 'approval_grant_used', 'approval_waived', 'approval_revoked', 'approval_interrupted',
        'integration_connected', 'integration_disconnected',
        'connector_requested', 'connector_connected', 'connector_failed', 'connector_disconnect_requested', 'connector_disconnected',
        'vault_saved', 'vault_deleted', 'vault_file_saved', 'vault_file_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
        'budget_warning', 'selftest'
      ) then 'security'
      -- Opening a file from the vault is an access to the owner's documents, even if it goes to them.
      when p.event = 'tool_call' and p.detail ->> 'tool' = 'vault_file' then 'security'
      when p.event like 'memory\_%' then 'memory'
      when p.event in (
        'error', 'outbound_failed', 'channel_disconnected', 'delivery_health', 'mail_trigger', 'schedule_failed',
        'turn_recovered', 'turn_abandoned', 'task_interrupted'
      ) then 'system'
      when p.event = 'tool_call' and p.detail ->> 'level' = 'read' and p.detail ->> 'tool' <> 'run_task' then 'access'
      else 'action'
    end as category,
    case
      when p.event = 'tool_call' and p.detail ? 'result'
        then jsonb_set(p.detail, '{result}', to_jsonb(left(p.detail ->> 'result', 500)))
      else p.detail
    end as detail,
    f.content as fact
  from picked p
  left join public.facts f
    on p.event = 'memory_fact' and f.id::text = p.detail ->> 'fact_id';

revoke all on public.web_audit from anon, authenticated;
grant select on public.web_audit to serain_web;
