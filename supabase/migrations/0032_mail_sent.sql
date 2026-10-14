-- Serain: replies to mails Serain sent (addendum to D33 of 2026-10-13). Additive.
--
-- On the owner's behalf Serain sent a ticket request. The reply came the next
-- morning and was dropped by the mail trigger as "unimportant": `judge` saw a
-- polite confirmation without a deadline and without a request. That the owner was waiting for exactly this
-- reply, because they had given Serain the job, was the one thing the
-- code did not know. Now it remembers the `Message-ID` of every mail that `mail_send`
-- sends, and recognizes a reply by `References`/`In-Reply-To`.
--
-- Only the identifier, never recipient, subject or text (W13). `on delete cascade`
-- as with `mail_items`: whoever deletes the credential deletes this too.
create table if not exists public.mail_sent (
  id              bigint generated always as identity primary key,
  integration_id  text not null references public.integrations (id) on delete cascade,
  message_id      text not null unique,
  sent_at         timestamptz not null default now()
);

create index if not exists mail_sent_sent_at_idx on public.mail_sent (sent_at desc);

alter table public.mail_sent enable row level security;
revoke all on public.mail_sent from anon, authenticated;

-- The new kind in `mail_items`: a reply to Serain's mail, always reported.
alter table public.mail_items drop constraint if exists mail_items_category_check;
alter table public.mail_items
  add constraint mail_items_category_check
  check (category in ('none', 'new_commitment', 'change', 'urgent', 'booking', 'lapse', 'reply'));
