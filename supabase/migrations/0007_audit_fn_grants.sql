-- Serain: the audit log's trigger function is not an RPC (D8.6).
-- On 2026-09-20 the Supabase security advisor reports lints 0028 and 0029:
-- `public.audit_log_append_only()` from `0001_core.sql` is SECURITY DEFINER and
-- executable for `anon` and `authenticated` via /rest/v1/rpc. Additive.

-- 1) SECURITY DEFINER was never needed. The function reads and writes nothing, it
-- only raises; for that it needs none of its owner's privileges. As invoker it runs
-- with the privileges of whoever attempts the update or delete, and fails
-- just the same. The fixed `search_path` stays.
alter function public.audit_log_append_only() security invoker;

-- 2) Privileges. As in `0003_memory.sql`: revoke from PUBLIC first, otherwise the
-- revoke on the named roles has no effect. A grant to `service_role` is missing
-- here on purpose: nobody calls the function. The trigger does not need
-- EXECUTE for the triggering role, Postgres checks the privilege only at `create trigger`.
revoke all on function public.audit_log_append_only() from public, anon, authenticated;
