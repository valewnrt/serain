-- Serain: web interface and vault on the server (D49). Additive.
--
-- The web interface (`web/`, on Cloudflare under its own domain) talks to the
-- database as its own role `serain_web`, never with the secret key. What this
-- role may do is exactly what the web interface can do, and no more:
--   - read: selected audit log entries, the memory, the
--     vault entries without the sealed part
--   - write: create, replace, delete vault entries, each only through
--     a function that writes to the audit log itself
--   - manage its own sessions and passkeys; a new passkey only
--     against a one-time code the owner generates on their own computer (`pnpm web enroll`)
-- A plaintext secret never reaches it: the vault is sealed to the server's public
-- key (src/vault/sealbox.ts), it does not see the credentials from
-- `integrations` at all.
--
-- The role's password is not here (repo), `pnpm web db-password` sets it.

-- 1) The role. Created without a password, so it cannot log in until then.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'serain_web') then
    create role serain_web login noinherit nocreatedb nocreaterole noreplication nobypassrls connection limit 5;
  end if;
end;
$$;

grant usage on schema public to serain_web;

-- 2) Vault. `sealed` contains the whole entry (name, hosts, login URL,
-- user, password, TOTP), sealed in the browser. The other columns are display
-- only; the server does not use them (src/vault/entry.ts).
create table if not exists public.vault_entries (
  site        text primary key check (site ~ '^[a-z][a-z0-9_-]{1,30}$'),
  username    text not null check (char_length(username) between 1 and 200),
  hosts       text[] not null check (cardinality(hosts) between 1 and 5),
  login_url   text not null check (login_url ~ '^https://' and char_length(login_url) <= 2000),
  totp        boolean not null default false,
  key_id      text not null check (key_id ~ '^[A-Za-z0-9_-]{11}$'),
  sealed      text not null check (sealed ~ '^sv1\.' and char_length(sealed) <= 8000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.vault_entries enable row level security;
revoke all on public.vault_entries from anon, authenticated;

create or replace view public.web_vault as
  select site, username, hosts, login_url, totp, key_id, created_at, updated_at
  from public.vault_entries;

-- 3) Login to the web interface: passkeys, one-time codes for enrollment,
-- challenges, sessions. Tokens are stored in the database only as SHA-256.
create table if not exists public.web_passkeys (
  id           text primary key check (id ~ '^[A-Za-z0-9_-]+$' and char_length(id) between 16 and 1024),
  public_key   bytea not null,
  counter      bigint not null default 0 check (counter >= 0),
  transports   text[] not null default '{}',
  label        text not null default '' check (char_length(label) <= 100),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.web_enrollments (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.web_challenges (
  id         uuid primary key default gen_random_uuid(),
  challenge  text not null check (char_length(challenge) between 16 and 200),
  purpose    text not null check (purpose in ('register', 'login')),
  expires_at timestamptz not null
);

create table if not exists public.web_sessions (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  passkey_id   text not null references public.web_passkeys (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Last confirmed via passkey. Changes to the vault require a fresh confirmation.
  verified_at  timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists web_sessions_expires_idx on public.web_sessions (expires_at);

alter table public.web_passkeys    enable row level security;
alter table public.web_enrollments enable row level security;
alter table public.web_challenges  enable row level security;
alter table public.web_sessions    enable row level security;
revoke all on public.web_passkeys, public.web_enrollments, public.web_challenges, public.web_sessions from anon, authenticated;

grant select, update (counter, last_used_at) on public.web_passkeys to serain_web;
grant select, insert, delete on public.web_challenges to serain_web;
grant select, insert, update (last_seen_at, verified_at, expires_at), delete on public.web_sessions to serain_web;

drop policy if exists web_passkeys_web on public.web_passkeys;
create policy web_passkeys_web on public.web_passkeys for all to serain_web using (true) with check (true);
drop policy if exists web_challenges_web on public.web_challenges;
create policy web_challenges_web on public.web_challenges for all to serain_web using (true) with check (true);
drop policy if exists web_sessions_web on public.web_sessions;
create policy web_sessions_web on public.web_sessions for all to serain_web using (true) with check (true);

-- 4) What the web interface shows from the audit log: what Serain does that the owner
-- does not see in the chat, without trivia. Not included: messages (they see those),
-- model calls, heartbeat rounds, memory gate, start and stop, the
-- individual steps of a task (the task itself and its end are included)
-- and eval runs. This way the role also reads no chat text from the
-- arguments of `send_message` and the like.
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

-- 5) What Serain knows about the owner, for viewing: user model (newest version),
-- valid facts, approved procedures. Read only; forgetting stays in the chat
-- (`forget_fact`), because there it is in the history in the owner's own words.
create or replace view public.web_user_model as
  select v.base, v.learned, v.source, v.created_at
  from public.user_model_versions v
  order by v.created_at desc
  limit 1;

create or replace view public.web_facts as
  select f.id, f.category, f.content, f.kind, f.valid_from, f.valid_until, f.confidence, f.created_at, f.updated_at
  from public.facts f
  where f.subject = 'owner' and f.superseded_by is null;

create or replace view public.web_procedures as
  select p.id, p.title, p.trigger, p.body, p.created_at
  from public.procedures p;

revoke all on public.web_vault, public.web_audit, public.web_user_model, public.web_facts, public.web_procedures from anon, authenticated;
grant select on public.web_vault, public.web_audit, public.web_user_model, public.web_facts, public.web_procedures to serain_web;

-- 6) Write paths, each with an audit entry in the same transaction.
create or replace function public.web_vault_put(
  p_site text, p_username text, p_hosts text[], p_login_url text, p_totp boolean, p_key_id text, p_sealed text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replaced boolean;
begin
  select exists (select 1 from public.vault_entries e where e.site = p_site) into v_replaced;
  insert into public.vault_entries (site, username, hosts, login_url, totp, key_id, sealed)
  values (p_site, p_username, p_hosts, p_login_url, p_totp, p_key_id, p_sealed)
  on conflict (site) do update
    set username = excluded.username, hosts = excluded.hosts, login_url = excluded.login_url,
        totp = excluded.totp, key_id = excluded.key_id, sealed = excluded.sealed, updated_at = now();
  insert into public.audit_log (event, actor, detail)
  values ('vault_saved', 'web', jsonb_build_object('site', p_site, 'username', p_username, 'hosts', to_jsonb(p_hosts), 'totp', p_totp, 'replaced', v_replaced));
end;
$$;

create or replace function public.web_vault_delete(p_site text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.vault_entries e where e.site = p_site;
  if not found then
    return false;
  end if;
  insert into public.audit_log (event, actor, detail) values ('vault_deleted', 'web', jsonb_build_object('site', p_site));
  return true;
end;
$$;

create or replace function public.web_enrollment_valid(p_token_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.web_enrollments e
    where e.token_hash = p_token_hash and e.used_at is null and e.expires_at > now()
  );
$$;

create or replace function public.web_register_passkey(
  p_token_hash text, p_id text, p_public_key bytea, p_counter bigint, p_transports text[], p_label text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.web_enrollments e set used_at = now()
  where e.token_hash = p_token_hash and e.used_at is null and e.expires_at > now();
  if not found then
    return false;
  end if;
  insert into public.web_passkeys (id, public_key, counter, transports, label)
  values (p_id, p_public_key, p_counter, coalesce(p_transports, '{}'), coalesce(p_label, ''));
  insert into public.audit_log (event, actor, detail)
  values ('web_passkey_added', 'web', jsonb_build_object('passkey', left(p_id, 12), 'label', coalesce(p_label, '')));
  return true;
end;
$$;

-- Only the login events, only small details. Everything else the web interface
-- writes through the functions above or not at all.
create or replace function public.web_audit_append(p_event text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event not in ('web_login', 'web_logout', 'web_login_failed') then
    raise exception 'web_audit_append: Ereignis % nicht erlaubt', p_event;
  end if;
  if pg_column_size(p_detail) > 2000 then
    raise exception 'web_audit_append: Detail zu groß';
  end if;
  insert into public.audit_log (event, actor, detail) values (p_event, 'web', coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.web_vault_put(text, text, text[], text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.web_vault_delete(text) from public, anon, authenticated;
revoke all on function public.web_enrollment_valid(text) from public, anon, authenticated;
revoke all on function public.web_register_passkey(text, text, bytea, bigint, text[], text) from public, anon, authenticated;
revoke all on function public.web_audit_append(text, jsonb) from public, anon, authenticated;
grant execute on function public.web_vault_put(text, text, text[], text, boolean, text, text) to serain_web;
grant execute on function public.web_vault_delete(text) to serain_web;
grant execute on function public.web_enrollment_valid(text) to serain_web;
grant execute on function public.web_register_passkey(text, text, bytea, bigint, text[], text) to serain_web;
grant execute on function public.web_audit_append(text, jsonb) to serain_web;
