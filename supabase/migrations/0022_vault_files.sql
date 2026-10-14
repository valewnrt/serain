-- Serain: files in the vault (addendum to D49 of 2026-10-08). Additive.
--
-- The owner stores files in the web interface that they will need at some point (ID card,
-- certificates). Like the credentials they are sealed in the browser, to the
-- server's public key (src/vault/sealbox.ts, `sealBytesTo`);
-- only the server can open them. The web interface can store, replace,
-- delete, never read. File name, type and size sit next to it for
-- display only; the server uses what is in the sealed part (src/vault/file.ts).

create table if not exists public.vault_files (
  name        text primary key check (name ~ '^[a-z][a-z0-9_-]{1,30}$'),
  filename    text not null check (char_length(filename) between 1 and 120 and filename !~ '[\x01-\x1f\x7f<>"`\\/]'),
  mime_type   text not null check (mime_type ~ '^[a-z]+/[a-z0-9.+-]{1,80}$'),
  size        integer not null check (size between 1 and 10485760),
  key_id      text not null check (key_id ~ '^[A-Za-z0-9_-]{11}$'),
  -- Sealing (102 bytes), length field (4), header (2 to 1024), content: so the displayed size does not lie.
  sealed      bytea not null check (octet_length(sealed) between size + 108 and size + 1130),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.vault_files enable row level security;
revoke all on public.vault_files from anon, authenticated;

create or replace view public.web_vault_files as
  select name, filename, mime_type, size, key_id, created_at, updated_at
  from public.vault_files;

revoke all on public.web_vault_files from anon, authenticated;
grant select on public.web_vault_files to serain_web;

-- Store or replace, with limits on count and total size (free quota)
-- and an audit entry in the same transaction. Returns: 'ok', 'too_many', 'too_big'.
create or replace function public.web_vault_file_put(
  p_name text, p_filename text, p_mime_type text, p_size integer, p_key_id text, p_sealed bytea
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replaced boolean;
  v_count integer;
  v_total bigint;
begin
  -- Two concurrent uploads must not both slip in under the limit.
  perform pg_advisory_xact_lock(hashtext('public.vault_files'));
  select exists (select 1 from public.vault_files f where f.name = p_name) into v_replaced;
  select count(*), coalesce(sum(f.size), 0) into v_count, v_total from public.vault_files f where f.name <> p_name;
  if v_count >= 25 then
    return 'too_many';
  end if;
  if v_total + p_size > 104857600 then
    return 'too_big';
  end if;
  insert into public.vault_files (name, filename, mime_type, size, key_id, sealed)
  values (p_name, p_filename, p_mime_type, p_size, p_key_id, p_sealed)
  on conflict (name) do update
    set filename = excluded.filename, mime_type = excluded.mime_type, size = excluded.size,
        key_id = excluded.key_id, sealed = excluded.sealed, updated_at = now();
  insert into public.audit_log (event, actor, detail)
  values ('vault_file_saved', 'web', jsonb_build_object('name', p_name, 'filename', p_filename, 'size', p_size, 'replaced', v_replaced));
  return 'ok';
end;
$$;

create or replace function public.web_vault_file_delete(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.vault_files f where f.name = p_name;
  if not found then
    return false;
  end if;
  insert into public.audit_log (event, actor, detail) values ('vault_file_deleted', 'web', jsonb_build_object('name', p_name));
  return true;
end;
$$;

revoke all on function public.web_vault_file_put(text, text, text, integer, text, bytea) from public, anon, authenticated;
revoke all on function public.web_vault_file_delete(text) from public, anon, authenticated;
grant execute on function public.web_vault_file_put(text, text, text, integer, text, bytea) to serain_web;
grant execute on function public.web_vault_file_delete(text) to serain_web;

-- The audit in the web interface knows the new events. Otherwise unchanged from
-- 0019_recovery.sql. `vault_files` (only the list) is trivia; `vault_file` (a
-- file opened) is included, under security.
create or replace view public.web_audit as
  with surface(tool) as (
    values ('send_message'), ('reply_in_thread'), ('react'), ('edit_message'), ('end_turn'),
           ('cancel_silently'), ('show_memory'), ('list_schedules'), ('watch_list'), ('finish_task'),
           ('web_search'), ('web_fetch'), ('web_browse'), ('run_code'), ('mac_browser'),
           ('site_look'), ('site_act'), ('confirm_selftest'), ('vault_files')
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
