-- Serain: more connections for the web interface's role (D49). Additive.
--
-- Live 2026-10-08: saving in the vault failed with "internal error". The
-- role was allowed 5 connections, Hyperdrive kept 5 open (pool up to 20), and
-- every further login failed on the role limit. Hyperdrive is now limited to
-- 5 (scripts/web-cloudflare.ts); that is a soft limit, so the role
-- leaves headroom. It remains a limit: a bug in the worker cannot drain the
-- database.

alter role serain_web connection limit 10;
