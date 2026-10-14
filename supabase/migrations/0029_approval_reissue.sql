-- Serain: reissue an expired preview (addendum to D8 of 2026-10-10).
-- Additive.
--
-- A 👍 or "ja" on a preview that has passed its deadline no longer fizzles out
-- silently: the same preview comes back fresh with the same stored
-- arguments (new row, new deadline, new channel ID), and execution only happens
-- after a new 👍.
--
-- 1. `expired_answered_at`: an expired approval is answered exactly once
--    (reissued or "that one has expired."). The conditional
--    update on `expired_answered_at is null` is the lock against two 👍.
-- 2. `reissued_from`: the new row points to the old one. A reissued
--    one is not reissued again, and money never is, here too
--    as a check.
-- 3. The audit in the web interface shows `approval_reissued` and
--    `approval_reissue_refused` as security events. Otherwise unchanged
--    from 0026_approve_later_quotes.sql.

alter table public.approvals
  add column if not exists expired_answered_at timestamptz,
  add column if not exists reissued_from uuid references public.approvals (id) on delete set null;

alter table public.approvals drop constraint if exists approvals_reissue_check;
alter table public.approvals add constraint approvals_reissue_check
  check (reissued_from is null or level <> 'money');

alter table public.approvals drop constraint if exists approvals_expired_answered_check;
alter table public.approvals add constraint approvals_expired_answered_check
  check (expired_answered_at is null or status = 'expired');

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
          'approval_scheduled', 'approval_later_refused', 'approval_cancelled', 'approval_due', 'approval_missed', 'approval_reissued', 'approval_reissue_refused',
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
        'approval_scheduled', 'approval_later_refused', 'approval_cancelled', 'approval_due', 'approval_missed', 'approval_reissued', 'approval_reissue_refused',
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
