-- Serain: iCloud calendar via CalDAV (D54). Additive.
--
-- A third credential type next to IMAP and Google: Apple ID with an app-specific
-- password, sealed like the others (W16). Only the kind check gets
-- wider; existing rows stay valid unchanged.

alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations
  add constraint integrations_kind_check check (kind in ('imap', 'google', 'caldav'));
