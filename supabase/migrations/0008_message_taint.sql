-- Serain: provenance of outbound messages (D8.4, addendum to D8 and D13 of 2026-10-02).
-- Additive.
--
-- A message that Serain wrote in a turn with foreign content
-- (mail trigger, executor result, anything after a tool with
-- `returnsUntrusted`) is derived from that content. Without a marker it came back
-- in the next turn as Serain's own words, also in turns the owner
-- triggered that have owner-only tools, and through the rolling
-- summaries permanently into memory ("prompt laundering", IronCore Labs).
--
-- Empty means clean. Inbound messages always stay empty: the owner's words
-- are never foreign content, images carry their framing in `attachments` (D21).

alter table public.messages
  add column if not exists taint_sources text[] not null default '{}';

-- Backfill for what already exists, as far as the audit log allows: since
-- phase 2 it records the turn's origin on every message that went out through a
-- message tool. A turn with origin `untrusted` or `task` always carries
-- foreign content. Not reconstructable is taint that a turn only got
-- through a tool; such messages drop out of history and the summary
-- window over time.
update public.messages as m
   set taint_sources = array['vor 0008: Turn der Herkunft ' || (a.detail ->> 'origin')]
  from public.audit_log as a
 where a.event = 'outbound'
   and a.message_id = m.id
   and m.direction = 'outbound'
   and m.taint_sources = '{}'
   and a.detail ->> 'origin' in ('untrusted', 'task');
