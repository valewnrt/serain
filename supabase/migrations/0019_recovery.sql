-- Serain: turns and tasks survive a crash (D52). Additive.
--
-- A planned restart waits for `work.json` (src/health/work.ts). A real
-- crash does not: the running turn is gone, the owner's message stays unanswered,
-- and a background task lived only in memory. Both are now in the
-- database, and a pass at startup picks them up:
--   messages.turn_status  The owner's message is accepted, its turn is not done yet.
--                         At startup it is caught up, with a note on what was already
--                         done. Older than a day: abandoned, audit only.
--   tasks                 A running task. At startup it is reported, never
--                         silently repeated (like a pending approval, D14).

-- Null means: no turn owed (Serain's own messages, everything before this
-- migration). Only `storeInbound` sets `pending`.
alter table public.messages
  add column if not exists turn_status text
  check (turn_status in ('pending', 'done', 'abandoned'));

create index if not exists messages_turn_pending_idx
  on public.messages (created_at) where turn_status = 'pending';

create table if not exists public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  -- The task text as Serain phrased it (run_task is cleanTurnOnly,
  -- so from the owner's words). Only as long as it is needed: cleared at the end.
  task                text not null,
  -- Logged-in session on this site instead of research (D36).
  site                text,
  trigger_message_id  uuid references public.messages (id) on delete set null,
  trigger_external_id text not null default '',
  -- Is there a 🔍 on the triggering message? Then it becomes ✅ or ❌.
  acked               boolean not null default false,
  -- `running` until the result turn is done, not just until the executor is finished:
  -- a report nobody ever phrased is as lost as a task.
  status              text not null default 'running'
                      check (status in ('running', 'done', 'cancelled', 'interrupted')),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz
);

create index if not exists tasks_running_idx on public.tasks (started_at) where status = 'running';

alter table public.tasks enable row level security;

-- The web interface shows what was caught up and what was interrupted. Otherwise unchanged
-- from 0018_approval_waived.sql.
create or replace view public.web_audit as
  with surface(tool) as (
    values ('send_message'), ('reply_in_thread'), ('react'), ('edit_message'), ('end_turn'),
           ('cancel_silently'), ('show_memory'), ('list_schedules'), ('watch_list'), ('finish_task'),
           ('web_search'), ('web_fetch'), ('web_browse'), ('run_code'), ('mac_browser'),
           ('site_look'), ('site_act'), ('confirm_selftest')
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
          'vault_saved', 'vault_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
          'budget_warning', 'selftest',
          'task_finished', 'task_cancelled', 'task_interrupted', 'schedule_fired', 'schedule_failed',
          'turn_recovered', 'turn_abandoned',
          'memory_forget', 'memory_user_model',
          'error', 'outbound_failed', 'channel_disconnected', 'delivery_health'
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
      when p.event in (
        'inbound_rejected', 'kill_switch', 'kill_switch_release', 'tool_denied',
        'approval_requested', 'approval_decided', 'approval_denied', 'approval_expired',
        'approval_grant', 'approval_grant_used', 'approval_waived', 'approval_revoked', 'approval_interrupted',
        'integration_connected', 'integration_disconnected',
        'connector_requested', 'connector_connected', 'connector_failed', 'connector_disconnect_requested', 'connector_disconnected',
        'vault_saved', 'vault_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
        'budget_warning', 'selftest'
      ) then 'security'
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
