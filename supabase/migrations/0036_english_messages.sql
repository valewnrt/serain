-- Serain: messages from the database in English. Additive.
--
-- Three functions carried German texts. One of them reaches the owner: the
-- error of a connection the provider refused (0017) is shown as stored in the
-- "Connections" tab, and the web interface is English. The other two are
-- developer messages (append-only trigger from 0001, login audit from 0016).
-- Same signatures, same behaviour, same security settings as their latest
-- version (`audit_log_append_only` became `security invoker` in 0007);
-- `create or replace` keeps the grants and revokes.
--
-- Errors stored before this migration keep their text.

create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only (% not allowed)', tg_op;
end;
$$;

create or replace function public.web_audit_append(p_event text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event not in ('web_login', 'web_logout', 'web_login_failed') then
    raise exception 'web_audit_append: event % not allowed', p_event;
  end if;
  if pg_column_size(p_detail) > 2000 then
    raise exception 'web_audit_append: detail too large';
  end if;
  insert into public.audit_log (event, actor, detail) values (p_event, 'web', coalesce(p_detail, '{}'::jsonb));
end;
$$;

create or replace function public.web_connector_finish(p_id text, p_state_hash text, p_callback text, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error is not null then
    update public.connectors c
      set status = 'failed', error = left('Not approved at the provider: ' || p_error, 300), authorize_url = null,
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
