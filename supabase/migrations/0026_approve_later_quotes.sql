-- Serain: package 5 of 2026-10-08 (addenda to D14 and D43). Additive.
--
-- 1. "ja, aber morgen um 8" ("yes, but tomorrow at 8"): an approval can be scheduled. It stays in
--    `approvals`, not in `schedules`: after a crash the scheduler deliberately
--    catches up twice (D15), a mail must never go out twice (D14). New
--    states `scheduled` (the owner has agreed, execution waits for
--    `execute_at`) and `cancelled` (called off beforehand). `later_pin` is the state
--    the tool records when scheduling (which mailbox a missing
--    `account` meant); if it differs at execution time, nothing runs.
--    `taint_sources` is the preview's provenance (D8.4), so the overview can
--    frame it. Money is never scheduled, here too as a check.
--
-- 2. Watchers of type `quote`: prices of crypto, currencies and stocks via a fixed
--    source in code, without a page and anchor.
--
-- 3. The audit in the web interface shows the new approval events as
--    security events. Otherwise unchanged from 0024_overview_areas_feedback.sql.

alter table public.approvals
  add column if not exists execute_at timestamptz,
  add column if not exists later_pin jsonb,
  add column if not exists taint_sources text[] not null default '{}';

alter table public.approvals drop constraint if exists approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('pending', 'scheduled', 'approved', 'denied', 'expired', 'executed', 'failed', 'cancelled'));

alter table public.approvals drop constraint if exists approvals_later_check;
alter table public.approvals add constraint approvals_later_check
  check (execute_at is null or level <> 'money');

alter table public.approvals drop constraint if exists approvals_scheduled_check;
alter table public.approvals add constraint approvals_scheduled_check
  check (status <> 'scheduled' or execute_at is not null);

create index if not exists approvals_scheduled_idx on public.approvals (execute_at)
  where status = 'scheduled';

alter table public.watchers drop constraint if exists watchers_kind_check;
alter table public.watchers add constraint watchers_kind_check
  check (kind in ('url_value', 'status_changes', 'mail_arrives', 'quote'));

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
          'approval_scheduled', 'approval_later_refused', 'approval_cancelled', 'approval_due', 'approval_missed',
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
        'approval_scheduled', 'approval_later_refused', 'approval_cancelled', 'approval_due', 'approval_missed',
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
