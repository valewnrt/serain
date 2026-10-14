-- Serain: connections from the web interface (D51). Additive.
--
-- The owner connects services (COROS, bank) in the web interface. Server and
-- web interface meet only here (D49): the web interface creates a request,
-- the server builds the authorization URL, the owner authorizes at the provider, the
-- browser stores the callback sealed, the server redeems it. Only the server
-- sees tokens.
--
--   starting       web interface: the owner wants to connect
--   authorizing    server: authorization URL is ready (`authorize_url`)
--   finishing      web interface: the provider's callback is sealed in `callback`
--   connected      server: tokens are sealed in `sealed`
--   failed         server or web interface: with `error`
--   disconnecting  web interface: the owner wants to disconnect; the server revokes and deletes
--
-- The server seals `pending` and `sealed` with `SERAIN_INTEGRATION_KEY`
-- (AES-256-GCM, like `integrations`), the browser seals `callback` to the server's public
-- vault key. The role `serain_web` sees none of the three.

create table if not exists public.connectors (
  id            text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  status        text not null check (status in ('starting', 'authorizing', 'finishing', 'connected', 'failed', 'disconnecting')),
  -- Origin of the web interface that wants to connect. The server only accepts it if it is on its list.
  origin        text not null check (origin ~ '^https?://[a-z0-9.:-]+$' and char_length(origin) <= 100),
  authorize_url text check (authorize_url is null or (authorize_url ~ '^https://' and char_length(authorize_url) <= 4000)),
  state_hash    text check (state_hash is null or state_hash ~ '^[0-9a-f]{64}$'),
  pending       text check (pending is null or (pending ~ '^v1\.' and char_length(pending) <= 8000)),
  callback      text check (callback is null or (callback ~ '^sv1\.' and char_length(callback) <= 8000)),
  sealed        text check (sealed is null or (sealed ~ '^v1\.' and char_length(sealed) <= 16000)),
  account       text not null default '' check (char_length(account) <= 200),
  -- Tools as the server found them when connecting (src/connectors/types.ts, snapshot). Only names and levels.
  tools         jsonb not null default '{}'::jsonb check (pg_column_size(tools) <= 16000),
  error         text check (error is null or char_length(error) <= 500),
  requested_at  timestamptz not null default now(),
  connected_at  timestamptz,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);

-- The server asks for work every two seconds; there almost never is any.
create index if not exists connectors_work_idx on public.connectors (status)
  where status in ('starting', 'authorizing', 'finishing', 'disconnecting');

alter table public.connectors enable row level security;
revoke all on public.connectors from anon, authenticated;

-- Registrations with issuers (RFC 7591): once per issuer and
-- redirect URI, so not every connect creates a new client.
-- `sealed` contains the client ID and, if the issuer issues one, the secret.
-- Only the server reads and writes here.
create table if not exists public.connector_clients (
  issuer       text not null check (issuer ~ '^https://' and char_length(issuer) <= 300),
  redirect_uri text not null check (redirect_uri ~ '^https?://' and char_length(redirect_uri) <= 300),
  sealed       text not null check (sealed ~ '^v1\.' and char_length(sealed) <= 4000),
  created_at   timestamptz not null default now(),
  primary key (issuer, redirect_uri)
);

alter table public.connector_clients enable row level security;
revoke all on public.connector_clients from anon, authenticated;

-- What the web interface sees: state, account, tools, error. The
-- authorization URL only as long as it is needed.
create or replace view public.web_connectors as
  select
    c.id, c.status, c.account, c.tools, c.error, c.requested_at, c.connected_at, c.expires_at, c.updated_at,
    case when c.status = 'authorizing' then c.authorize_url end as authorize_url
  from public.connectors c;

revoke all on public.web_connectors from anon, authenticated;
grant select on public.web_connectors to serain_web;

-- Start connecting. If a connection is already running or one is currently being
-- redeemed or disconnected, everything stays as it is. An expired
-- bank authorization can be renewed directly; the server replaces the old tokens.
create or replace function public.web_connector_start(p_id text, p_origin text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.connectors (id, status, origin) values (p_id, 'starting', p_origin)
  on conflict (id) do update
    set status = 'starting', origin = excluded.origin, authorize_url = null, state_hash = null, pending = null,
        callback = null, error = null, requested_at = now(), updated_at = now()
    where public.connectors.status in ('starting', 'authorizing', 'failed')
       or (public.connectors.status = 'connected' and public.connectors.expires_at < now());
  if not found then
    return false;
  end if;
  insert into public.audit_log (event, actor, detail) values ('connector_requested', 'web', jsonb_build_object('id', p_id));
  return true;
end;
$$;

-- Callback from the provider. Only for the authorization currently running, only with the
-- `state` the server issued for it, and only within 15 minutes.
-- With `p_error` (the owner declined at the provider) it ends as failed.
create or replace function public.web_connector_finish(p_id text, p_state_hash text, p_callback text, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error is not null then
    update public.connectors c
      set status = 'failed', error = left('Beim Anbieter nicht freigegeben: ' || p_error, 300), authorize_url = null,
          state_hash = null, pending = null, updated_at = now()
      where c.id = p_id and c.status = 'authorizing' and c.state_hash = p_state_hash;
  else
    update public.connectors c
      set status = 'finishing', callback = p_callback, authorize_url = null, updated_at = now()
      where c.id = p_id and c.status = 'authorizing' and c.state_hash = p_state_hash
        and c.requested_at > now() - interval '15 minutes';
  end if;
  return found;
end;
$$;

-- Disconnect. The server revokes and deletes an existing connection; one
-- that never came about goes immediately.
create or replace function public.web_connector_disconnect(p_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select c.status into v_status from public.connectors c where c.id = p_id for update;
  if v_status is null then
    return false;
  end if;
  if v_status in ('connected', 'finishing', 'disconnecting') then
    update public.connectors c set status = 'disconnecting', updated_at = now() where c.id = p_id;
  else
    delete from public.connectors c where c.id = p_id;
  end if;
  insert into public.audit_log (event, actor, detail) values ('connector_disconnect_requested', 'web', jsonb_build_object('id', p_id, 'status', v_status));
  return true;
end;
$$;

revoke all on function public.web_connector_start(text, text) from public, anon, authenticated;
revoke all on function public.web_connector_finish(text, text, text, text) from public, anon, authenticated;
revoke all on function public.web_connector_disconnect(text) from public, anon, authenticated;
grant execute on function public.web_connector_start(text, text) to serain_web;
grant execute on function public.web_connector_finish(text, text, text, text) to serain_web;
grant execute on function public.web_connector_disconnect(text) to serain_web;

-- The audit in the web interface knows the new events (otherwise as 0016_web.sql).
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
          'approval_grant', 'approval_grant_used', 'approval_revoked',
          'integration_connected', 'integration_disconnected',
          'connector_requested', 'connector_connected', 'connector_failed', 'connector_disconnect_requested', 'connector_disconnected',
          'vault_saved', 'vault_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
          'budget_warning', 'selftest',
          'task_finished', 'task_cancelled', 'schedule_fired', 'schedule_failed',
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
        'approval_grant', 'approval_grant_used', 'approval_revoked',
        'integration_connected', 'integration_disconnected',
        'connector_requested', 'connector_connected', 'connector_failed', 'connector_disconnect_requested', 'connector_disconnected',
        'vault_saved', 'vault_deleted', 'web_login', 'web_logout', 'web_login_failed', 'web_passkey_added', 'web_passkey_removed',
        'budget_warning', 'selftest'
      ) then 'security'
      when p.event like 'memory\_%' then 'memory'
      when p.event in ('error', 'outbound_failed', 'channel_disconnected', 'delivery_health', 'mail_trigger', 'schedule_failed') then 'system'
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
