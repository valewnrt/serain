-- Serain: the server's tick directly over Postgres (addendum to D50 of 2026-10-11). Additive.
--
-- Until now every server query went through PostgREST. When idle that was
-- about 40,000 requests a day (scheduler, watchers, approvals,
-- connections, mail tick, health), each with about 1 KB egress for the
-- headers and about 2 KB of log at Supabase. That alone put Serain over the
-- log quota of Supabase Free. The tick's queries therefore run over
-- a persistent connection to the pooler, as their own role `serain_server`.
--
-- The role may do exactly what the tick needs, and no more:
--   - read: kill switch and mail trigger state, due items from `schedules`,
--     `watchers` and `approvals`, open connections, open mail entries,
--     health and open incidents, from `integrations` only ID and cursor
--     (`state`), never the sealed part
--   - write: set expired previews to `expired`, the mail
--     trigger state, a mailbox's cursor, its own health
-- Everything else (turns, tools, audit log) stays with the secret key over PostgREST.
--
-- The role's password is not here (repo), `pnpm db:password` sets it.

-- 1) The role. Created without a password, so it cannot log in until then.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'serain_server') then
    create role serain_server login noinherit nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
  end if;
end;
$$;

grant usage on schema public to serain_server;

-- 2) State: read only kill switch and mail trigger, write only the mail trigger.
-- `on conflict … do update` reads the columns it sets: hence `updated_at` is readable too.
grant select (key, value, updated_at), insert (key, value, updated_at), update (value, updated_at) on public.agent_state to serain_server;
drop policy if exists agent_state_server_read on public.agent_state;
create policy agent_state_server_read on public.agent_state for select to serain_server
  using (key in ('kill_switch', 'mail_trigger'));
drop policy if exists agent_state_server_insert on public.agent_state;
create policy agent_state_server_insert on public.agent_state for insert to serain_server
  with check (key = 'mail_trigger');
drop policy if exists agent_state_server_update on public.agent_state;
create policy agent_state_server_update on public.agent_state for update to serain_server
  using (key = 'mail_trigger') with check (key = 'mail_trigger');

-- 3) Approvals: read due items, let expired ones lapse. Nothing else:
-- claiming and executing stays with the secret key.
grant select on public.approvals to serain_server;
grant update (status, decided_at, decided_via) on public.approvals to serain_server;
drop policy if exists approvals_server_read on public.approvals;
create policy approvals_server_read on public.approvals for select to serain_server using (true);
drop policy if exists approvals_server_expire on public.approvals;
create policy approvals_server_expire on public.approvals for update to serain_server
  using (status = 'pending') with check (status = 'expired' and decided_via = 'timeout');

-- 4) Due items from scheduler and watchers, open connections: read only.
grant select on public.schedules, public.watchers, public.connectors to serain_server;
drop policy if exists schedules_server_read on public.schedules;
create policy schedules_server_read on public.schedules for select to serain_server using (true);
drop policy if exists watchers_server_read on public.watchers;
create policy watchers_server_read on public.watchers for select to serain_server using (true);
drop policy if exists connectors_server_read on public.connectors;
create policy connectors_server_read on public.connectors for select to serain_server using (true);

-- 5) Mailboxes: whether a credential still exists, and its cursor. Never the sealed part.
grant select (id, state), update (state, updated_at) on public.integrations to serain_server;
drop policy if exists integrations_server_read on public.integrations;
create policy integrations_server_read on public.integrations for select to serain_server using (true);
drop policy if exists integrations_server_cursor on public.integrations;
create policy integrations_server_cursor on public.integrations for update to serain_server using (true) with check (true);

grant select on public.mail_items to serain_server;
drop policy if exists mail_items_server_read on public.mail_items;
create policy mail_items_server_read on public.mail_items for select to serain_server using (true);

-- 6) Health (W11): its own state and open incidents.
grant select, insert, update on public.component_status to serain_server;
drop policy if exists component_status_server on public.component_status;
create policy component_status_server on public.component_status for all to serain_server using (true) with check (true);
grant select on public.incidents to serain_server;
drop policy if exists incidents_server_read on public.incidents;
create policy incidents_server_read on public.incidents for select to serain_server using (true);
