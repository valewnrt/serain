-- Serain: does the owner know the sender of a reported mail? (addendum to D33 of 2026-10-13). Additive.
--
-- The mail trigger reported a real mail from a known sender as
-- phishing, based only on the summary. Now the code checks, when
-- classifying, what it knows for certain about the sender, and the report turn sees
-- it outside the frame for foreign content:
--   known       the owner's mail provider confirmed the domain (DMARC, sender-auth.ts),
--               and mail already came from it more than 30 days ago.
--   new         confirmed, but never mail from there before.
--   unverified  not confirmed, the sender address may be forged.
--   null        the mailbox cannot tell, or the entry is older.

alter table public.mail_items add column if not exists sender_trust text;
alter table public.mail_items drop constraint if exists mail_items_sender_trust_check;
alter table public.mail_items
  add constraint mail_items_sender_trust_check
  check (sender_trust in ('known', 'new', 'unverified'));
