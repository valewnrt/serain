-- Serain: findings from the mail (addendum to D33 of 2026-10-10). Additive.
--
-- Two new kinds in `mail_items`, both from mails that must not interrupt the owner
-- (confirmations, tickets, pickup slips):
--   booking  confirms a fixed appointment to the owner. `commitment.event` carries the
--            checked appointment; if it is not already in the calendar, Serain offers
--            it with a preview.
--   lapse    after `commitment.due` something expires or costs something. Stored
--            with `notified_at`, reported only through the heartbeat's deadlines (D46).

alter table public.mail_items drop constraint if exists mail_items_category_check;
alter table public.mail_items
  add constraint mail_items_category_check
  check (category in ('none', 'new_commitment', 'change', 'urgent', 'booking', 'lapse'));
