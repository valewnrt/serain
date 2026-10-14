-- Serain: mails the owner is waiting for, because Serain promised to get back to them
-- (addendum to D33 of 2026-10-13). Additive.
--
-- Serain put an appointment in the owner's calendar and promised to get back as soon as place and
-- time came from the organizer. The mail came the same afternoon, with ticket
-- and place, and was dropped by the mail trigger as "unimportant". The promise was only in the chat. Now a
-- `mail_arrives` watcher with `awaited` holds it (spec in `watchers`, jsonb, no
-- schema change), and the trigger stores the matching mail as `awaited`
-- without `judge`, reported like a reply to Serain's own mail.
alter table public.mail_items drop constraint if exists mail_items_category_check;
alter table public.mail_items
  add constraint mail_items_category_check
  check (category in ('none', 'new_commitment', 'change', 'urgent', 'booking', 'lapse', 'reply', 'awaited'));
