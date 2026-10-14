-- Serain: files below the preview (addendum to D34 of 2026-10-08). Additive.
--
-- When `mail_send` attaches one of the owner's files, Serain sends it in the thread
-- directly below the preview, so the owner sees which document goes out. A 👍
-- or "ja" on this bubble is the same approval as on the preview; for that
-- the approval remembers the channel IDs of the files.

alter table public.approvals
  add column if not exists preview_file_external_ids text[] not null default '{}';

create index if not exists approvals_preview_files_pending_idx
  on public.approvals using gin (preview_file_external_ids)
  where status = 'pending';
