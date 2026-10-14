# Serain architecture

This document explains how Serain is built and, above all, which rules hold it together. It is the reference for every decision number you will find in the code: comments such as "D23" or "addendum D52 of 2026-10-10" point to the [decision register](#decision-register) at the end. The chapters before it cover the parts a contributor must understand before touching the runtime: the security model (D8), response time (D50), crash recovery (D52), steering (D57), fuzzing (D53), playbooks (D56) and languages.

Code, comments, prompts, tool descriptions and prompt tags (`<context>`, `<addendum>`, `<untrusted>` and so on) are English. Serain itself talks to the owner in whatever language the owner writes; how that works without weakening any rule below is [chapter 8](#8-languages).

## Contents

1. [Overview](#1-overview)
2. [Security model (D8)](#2-security-model-d8)
3. [Response time (D50)](#3-response-time-d50)
4. [Surviving a crash (D52)](#4-surviving-a-crash-d52)
5. [Steering a running turn (D57)](#5-steering-a-running-turn-d57)
6. [Fuzzing at the trust boundaries (D53)](#6-fuzzing-at-the-trust-boundaries-d53)
7. [Playbooks and login codes (D56)](#7-playbooks-and-login-codes-d56)
8. [Languages](#8-languages)
9. [Decision register](#decision-register)
10. [Other labels in the code (W, V, H)](#other-labels-in-the-code-w-v-h)

---

## 1. Overview

Serain is a personal AI agent for exactly one person, the owner. Its only interface is iMessage. It runs 24/7 as a single long-lived Node process on a server the owner controls, keeps its memory, audit log and budget in the owner's own Supabase project, and talks to iMessage through Photon (a relay service with a shared number, reached over an outgoing gRPC stream, so the server needs no open port). There is no multi-user mode and no hosted service: everyone runs their own instance.

Serain will eventually send mail and fill in forms on the owner's behalf. That is why the architecture is built around one idea: **the model proposes, the code decides.** Every boundary that matters (who may talk to Serain, what a tool may do, when the owner must confirm, what counts as foreign content) is enforced in deterministic code, never by a prompt or a model's judgement.

### Big picture

```
                         iMessage (owner's phone)
                                   │
                         Photon (shared number, gRPC stream out)
                                   │
┌──────────────────────────────────▼───────────────────────────────────────┐
│ Server process (Node 22, systemd)                                         │
│                                                                           │
│  Channel adapter  src/channel/photon/adapter.ts                           │
│        │                                                                  │
│  Ingress, before anything is stored or a model sees it:                   │
│    allowlist (src/security/allowlist.ts) ─ drops everyone but the owner   │
│    kill switch (src/security/killswitch.ts) ─ "serain stop" / "resume"    │
│    approval decisions, revoke, proposals, login codes (regex, no model)   │
│        │                                                                  │
│  ConversationQueue (src/security/queue.ts): 1 s window, preemption,       │
│  steering, one turn at a time                                             │
│        │                                                                  │
│  Runtime (src/runtime.ts) ─ builds context per turn from the database     │
│        │                                                                  │
│  Turn (src/agent/turn.ts) ── chat model via Claude Agent SDK              │
│        │                    (OpenRouter as paid fallback, src/agent/model.ts)
│        ▼                                                                  │
│  Tool registry (src/agent/tools/registry.ts) ── the only door to effects  │
│    levels, taint, approvals, link checks, limits, audit                   │
│        │                                                                  │
│        ├── messaging tools ──────────────► OutboundGate (src/outbound.ts) │
│        ├── mail, calendar, connectors, vault, memory, schedules           │
│        └── run_task ──► Executor (src/executor/)                          │
│                           web_fetch, web_search, web_browse (Chrome),     │
│                           media_watch, run_code (sandbox), forms          │
│                           report comes back as foreign content            │
│                                                                           │
│  Scheduler, heartbeat, mail trigger, watchers (all run through the queue) │
└──────────────┬──────────────────────────────┬─────────────────────────────┘
               │                              │
   Supabase Postgres                 Integrations (sealed credentials)
   memory, messages, audit log,      IMAP/SMTP, Gmail, iCloud CalDAV,
   approvals, tasks, usage_log       OAuth/MCP connectors, bank (read only)
               │
   Web interface (optional, web/): Cloudflare Worker behind Access,
   passkey login, audit/memory/vault/connections, own DB role
   Mac companion (optional, companion/): read-only Apple data and a
   local browser, reachable only through an SSH reverse tunnel
```

### Two agents, one registry each (D4, D16)

- **The chat turn** is Serain itself. It sees the owner's message, the user model, relevant facts and the recent history, and it acts only through tools. It does not "answer with text": it calls `send_message`, `reply_in_thread`, `react` and ends with `end_turn` (D11). Zero, one or several messages per turn are possible.
- **The executor** runs background jobs started with `run_task`. It has its own registry with read-only web tools and `finish_task`, no messaging tools and no tool of level 3 or 4. It knows neither memory nor history; the only thing a hostile web page could steal from it is the job text. Its report returns to the chat as foreign content.

### Context per turn, not an endless session (D4, D47)

Every turn rebuilds its context from the database: system prompt (rules, style, protocol, user model; stable so the prompt cache works), then a `<context>` block directly before the latest message with time, memory recall, playbooks, current disruptions and other per-turn data. There is no growing session. History lines carry time markers when a day changes or 30 minutes pass (`src/agent/timeline.ts`).

### Turn origins

Every turn carries an origin (`TurnOrigin` in `src/agent/tools/types.ts`). Rights depend on it:

| Origin | Trigger | Notes |
|---|---|---|
| `owner_message` | the owner wrote | the only origin with "owner's words"; clean until it reads foreign content |
| `owner_reaction` | owner's 👎 or ❓ on a Serain message | from the owner, but no instruction: owner-only tools stay locked |
| `approval` | owner approved a preview | formulates the result; inherits the preview's taint |
| `task` | executor report | tainted from the start |
| `schedule` | scheduled job, mission wake-up | owner asked at some point, not now: no owner-only tools |
| `heartbeat` | proactive check | three tools only |
| `untrusted` | mail trigger, watcher hit | tainted, three or four tools only |

### A tool is defined once (D11)

`defineTool` in `src/agent/tools/` declares name, description, Zod schema, level and handler, plus the flags the registry enforces: `ownerOriginOnly`, `cleanTurnOnly`, `origins`, `returnsUntrusted`, `privateResult`, `textToOwner`, `opensPages`, `vouchesSender`, `linkPreviews`, `repeatable`, `comesBack`, `answersOwner`, `endsTurn`, `confirm`, `consequence`, `timeoutMs`. `src/agent/model.ts` translates the same definition into an in-process MCP server for the Agent SDK and into AI SDK tools for the OpenRouter fallback, so both paths share one set of rules.

---

## 2. Security model (D8)

D8 lists the principles that stand before any feature. Each one is enforced in code. When you add or change anything, check it against this chapter; the [checklist](#28-what-you-must-not-break) at the end summarises it.

### 2.1 Ingress allowlist (D8.1)

Only messages from the owner's handle (`OWNER_PHONE`) reach storage and the model. Everything else is logged and dropped before any model call, in `checkIngress` (`src/security/allowlist.ts`). Group chats are rejected (the adapter recognises them by chat ID). Typing signals and reactions go through the same check. The allowlist is never optional, not even "just for testing", and there is no second handle: that is why Serain never messages third parties over iMessage (D34) and why the abandoned second channel was removed rather than left as dead code at this boundary (D27, see register).

### 2.2 Kill switch (D8.2)

A code word, matched by code outside the model loop (`detectKillSwitchCommand`, `src/security/killswitch.ts`, words in `src/i18n/words.ts`): `serain stop` at the start of a message stops everything, in every language (English, German and the owner's current language are always accepted together, so `serain stopp` works too); `serain resume` (`serain weiter`, or the current language's word) releases. On a doubt, stop wins. The state lives in `agent_state`, so a restart does not lift it, and it is re-read from the database rather than trusted from memory; an unreadable state counts as engaged.

What it does:
- the registry checks `halted` before **every** tool call, so a turn that is mid-model-call gets no tool through after the stop (D18);
- `runMessageTurn` re-checks at the start; queued turns do not run;
- pending previews expire immediately, scheduled approvals are cancelled (not paused), running executor jobs are aborted, the scheduler holds due entries until release, sandbox containers are killed via the dropped connection, waiting login sessions end;
- a turn retry waiting after an error is cancelled (D52).

The kill switch also beats everything else in ordering: it is checked at ingress, before approval decisions and before the queue. `serain revoke` (`serain widerruf`, or the current language's word) is the sibling command that removes all standing grants (`isRevokeCommand` in `src/security/approvals.ts`, parsed by the same `parseCommand`).

### 2.3 Tool levels and the confirmation protocol (D8.3, D14)

Four levels (`ToolLevel`): `read`, `write_reversible`, `irreversible`, `money`. The level measures reversibility, not "danger in general".

**Levels 3 and 4 never run from a model turn.** The registry hands the call to `ApprovalService.request` (`src/security/approvals.ts`): arguments are frozen in `approvals`, the owner gets a preview, the model only learns "waiting". Execution happens later via `executeApproved`, **with exactly the stored arguments**, never with a second model call. The registry refuses to even register a level 3/4 tool without a complete `confirm` spec (fail closed, D11).

- **The preview is built by the tool, not the model** (`confirm.preview(args)`, may be async and may read the mailbox itself, D37). A model that read a hostile page therefore cannot put a harmless preview in front of a different action. Every preview states the way back (`confirm.undo`, W4), even if it is "there is none". Previews ask their own question in one short sentence, list two or more items with "•" (`bulleted`, `src/text/list.ts`) and name senders by brand computed from the address (`senderLabel`, `src/mail/brand.ts`), never from a display name or the model. What matters (recipients and full text of a mail, spam senders with address, unsubscribe mails to non-processors, form fields with values) always stays visible.
- **The decision is code, before the model:** a 👍 (or 👎) tapback on the preview, in every language, or a reply in its thread that is *as a whole* a decision (`yes`, `ok`, `no`, `ja`, `nein` …; `parseConsent` in `src/i18n/words.ts`, the union of English, German and the owner's current language, a word that is both yes and no counts as no). A bare "yes" outside the thread does not count. `judge` never decides here (D12). Previews are sent as one bubble and not as thread replies, so the channel ID maps cleanly.
- **Window and caps:** 30 minutes (`APPROVAL_TTL_MS`), at most 3 open previews (`MAX_PENDING_APPROVALS`). Claiming is atomic (conditional update). An approval that was running when the process crashed is never re-executed; it is booked `failed` and reported (D52).
- **Level by consequence (W1):** `consequence(args)` can raise a single call's level, never lower it (a booking with a cancellation fee is `money`). Calendar entries with guests are `irreversible`, without guests `write_reversible`; the tool verifies the guest claim against the real event.
- **Standing grants** ("yes always", "ja immer") apply to exactly one tool and one `grantKey` (e.g. one recipient), only in a clean turn of origin `owner_message`, never for `money` (code and DB check), never for mails with attachments.
- **"Yes, but tomorrow at 8"** ("ja, aber morgen um 8") is parsed by regex into a scheduled execution (`src/security/later.ts`, state `scheduled` in `approvals`, at most 5). There are grammars for English and German only; in any other language a time is conversation and nothing is scheduled. The arguments are byte-compared and re-pinned before execution; never for `money`, files, or tools without `confirm.later`. Addendum D14 of 2026-10-08.
- **An expired preview is re-issued, not executed** when the owner answers it late (`ApprovalService.onExpired`): a new preview from the same stored arguments, a new 👍 required, never for money, never a standing grant. Addendum D8 of 2026-10-10.
- **No preview for what the owner just asked for, if the code can prove it** (`ConfirmSpec.namedByOwner`, `confirmFirst` in the registry). The proof only sees the owner's own words of this message (`TurnState.ownerWords`, never model text): e.g. up to three senders named for `mail_cleanup`, a site named for `web_form` or `run_site_task`, an event title plus a delete verb for `calendar_delete` without guests. Only for `irreversible`, never `money`, only in `owner_message` turns; logged as `approval_waived`. The rule behind it: a preview exists when third parties receive something, when Serain itself chose what happens, or when money is involved. Addenda D8 of 2026-10-03 and of 2026-10-13.

### 2.4 Foreign content and taint (D8.4)

Everything that does not come from the owner (mail, web pages, calendar invitations, attachments, connector results, executor reports, images) is data, never instruction.

- **`returnsUntrusted`** on a tool marks its result as foreign. The registry wraps it in `<untrusted source="…">` (`wrapUntrusted` in `src/security/untrusted.ts`) and adds a taint source to the turn. Wrapping happens exactly once, also for exceptions thrown by such tools; the wrapper defuses attempts to close the tag (invisible characters, full-width brackets) and to fake an `<addendum>` (also the old German tag names, `FRAMES` in `src/security/untrusted.ts`).
- **A tainted turn loses rights**, enforced by the registry with an audit entry (`tool_denied`):
  - `cleanTurnOnly`: the tool runs only while the turn has seen no foreign content. `run_task` is the prime example: its job text would otherwise be the way to carry the owner's data into a URL.
  - `ownerOriginOnly`: the tool runs only in a turn the owner triggered with a message, and (in the registry) only while clean. Used for `forget_fact`, `show_memory`, `schedule_task`, `cancel_schedule`, `watch_create`, `cancel_task`, `vault_file`, `edit_message`, connector writes and others.
  - `origins`: the tool exists only for listed origins (e.g. `cancel_silently` only in `heartbeat` and `schedule`; `calendar_offer` only in `untrusted`).
  - standing grants do not apply.
- **Follow-up turn instead of a dead end.** When the registry denies an `ownerOriginOnly` or `cleanTurnOnly` tool because of taint in an owner turn, it only notes the tool name (`TurnState.defer`) and tells the model it will run right after. The runtime then re-queues the same owner messages as a fresh, clean turn with a system hint (`followUp`, audit `turn_follow_up`). The denied arguments are not carried over: they were chosen by a model that had read foreign content. Only once, not if the taint came from the owner's own image. Addendum D8.4 of 2026-10-08.
- **Messages keep their provenance** (against "prompt laundering"). Every outbound path that carries model text (`send_message`, `reply_in_thread`, the text fallback, previews, reminders) records the turn's taint in `messages.taint_sources`; `storeOutbound` requires the field. In later turns, such messages appear in history wrapped as foreign content in Serain's role. Rolling summaries and the fact-extraction context replace them with a placeholder, so foreign text never enters memory (D13). Facts are created only from the owner's own words.
- **Images are foreign, voice messages are the owner's words** (D21). An image description is wrapped and taints the turn from the start; a transcript is stored as the owner's text.
- **Links to the owner after foreign content must be backed** (`textToOwner`, `src/security/links.ts`). A link in an outgoing text passes only if a tool with `opensPages` loaded exactly that page in this job, the owner wrote it himself, or (addendum D8.4 of 2026-10-12) it is the bare home page of a sender domain that `mail_read` verified via DMARC and that has sent mail for at least 30 days (`vouchesSender`, `src/mail/sender-auth.ts`). Otherwise `tool_denied`/`unbacked_link`, without the link in the audit log.
- **Link previews** (`links` on the messaging tools, `linkPreviews`) are even stricter: only https pages on public hosts that an `opensPages` tool (`web_fetch`, `web_browse`, `mac_browser`, `media_watch`) or the watcher poller actually opened, tracking parameters stripped, at most two per turn (`MAX_LINK_PREVIEWS_PER_TURN`), never alongside a screenshot. Any new tool that opens pages needs a classification and an entry in `test/fuzz/link-previews.test.ts`.
- **Event-driven turns get tiny toolboxes.** Mail trigger, heartbeat and watcher hits run with `send_message`, `cancel_silently`, `end_turn` (plus `calendar_offer` and `mission_note` in the mail turn) and no text fallback, so a mail can never cause `mail_send`, a fetch or a memory write.

### 2.5 Audit log and private results (D8.6)

Every message, tool call with arguments and result, denial, approval and security event is written to `audit_log`. The table is **append-only**, enforced by a trigger in `0001_core.sql`; a weekly self-test tries to modify and delete a synthetic row and alerts the owner if that succeeds or cannot be checked (D17). Because nothing can ever be deleted from it:

- **`privateResult`** tools (mail, calendar, connectors, file computations) log only call, arguments, success and result length, never content. Exceptions from such tools log only their length.
- Login codes, vault contents, passwords and tokens never reach it. Every entry is capped at 20,000 characters.
- The web interface reads the log only through the view `web_audit` with its own database role (D49).
- Tests and evals never write to the real database; `pnpm web:e2e` uses a throwaway database.

### 2.6 Secrets, sandbox, network, limits (D8.5, D8.7, D8.8)

- **Secrets** live in `.env` on the server and `.dev.vars` locally, never in prompts, logs or tool results. Integration credentials are sealed in the database (AES-256-GCM, key `SERAIN_INTEGRATION_KEY` only in the environment); the vault is sealed in the browser to the server's public key (`SERAIN_VAULT_KEY`, D49). Tools receive connected objects (`MailAccount`, `Calendar`), never credentials (credential surrogation, D30).
- **Confidential values never leave the server** (D29): `run_task` and every outbound path of the executor (URL, search, browser input) are checked by a deterministic filter for the owner's addresses, long numbers, mail addresses and IBANs drawn fresh from memory. Fail closed if memory is unreadable.
- **SSRF protection at the socket** (`src/executor/netguard.ts`): only public addresses, only ports 80/443, checked at the address actually connected to, every redirect rechecked. Browsers and the media downloader go through a filter proxy with the same rules.
- **Code and media parsers run in a sandbox** (D20): a root-owned helper behind a Unix socket starts fixed `docker run --network none --read-only --cap-drop ALL` jobs; the Serain service itself has no Docker rights, and no client value ever reaches the command line.
- **Built-in SDK tools are off** (D11): no shell, no file system; `canUseTool` rejects everything not from the registry.
- **Limits:** 4 messages, 2 tapbacks, 8 tool steps per turn (`src/config/limits.ts`); outbound rate limit 30 per hour and duplicate suppression for two minutes (`OutboundGate`); a per-call tool timeout (`TOOL_TIMEOUT_MS`, D53); a monthly API budget with throttling (D3).
- **`judge` is never a security decision** (D12): probabilities decide attention and memory, never levels, approvals, allowlist or taint.

### 2.7 Money

`money` exists as a level but no money tool is built. Buttons that look like buying, ordering, booking or paying are never clicked, not even with a preview (forms, logged-in sessions, D63); there are no standing grants, no scheduled execution and no re-issue for money.

### 2.8 What you must not break

- No path from a message to a model that skips the allowlist or the kill switch.
- No tool of level `irreversible`/`money` that runs without `confirm`, and no preview text written by the model.
- No way to execute an approval with arguments other than the stored ones.
- No new tool without the right flags: anything that returns foreign text is `returnsUntrusted`; anything that reveals private data to the log is `privateResult`; anything that acts on the owner's authority is `ownerOriginOnly`/`cleanTurnOnly`; anything that writes text to the owner is `textToOwner`; anything that opens web pages is classified for `opensPages`.
- No new outbound path that stores model text without taint, no memory write from foreign content.
- No security decision by a model, a probability or a prompt sentence.
- New ways in which an owner message gets handled without a turn must call `settleInbound` (D52).
- New services go into `src/connectors/drivers/index.ts` and the catalog, never directly into the runtime, so fuzzing covers them (D53).

---

## 3. Response time (D50)

Principle: **no waiting that decides nothing.** Where the time goes is recorded per turn in `model_call.detail.latency` (`wait`, `prep`, `warm`, `first_token`, `model`, `first_visible`, `reply`; `reply` is what the owner experiences).

- **Short window, latecomers preempt** (`ConversationQueue` in `src/security/queue.ts`, `Preemption` in `src/agent/tools/types.ts`). The debounce window is 1 s (`MESSAGE_DEBOUNCE_MS`). If a new message arrives while a turn runs that has not yet done anything visible or lasting, that turn ends (`turn_preempted`) and the next turn gets both messages. A turn **commits** in the registry, synchronously, before the first tool with an effect starts. Only pure read tools declare `repeatable: true` and do not commit; without the flag a tool commits (fail closed). `run_task` commits although it is level `read`, because it starts a job. A preempted turn learns nothing; already-read attachments pass to the successor.
- **Events have no window:** executor results, approvals, schedules, heartbeat, watchers and the mail trigger start immediately. A 👎 still waits, because words often follow.
- **Pre-warmed Agent SDK processes** (`prewarmTurn`, warm pool in `src/agent/model.ts`, slots `chat`, `executor`, `task_result`). A process matches exactly one turn shape (role, model, thinking, system prompt, tools, step limit, hashed); otherwise the turn runs cold. Tools are bound at turn time and always executed via that turn's registry. A waiting process sees nothing of the owner before the turn hands it the message, and is replaced after 20 minutes. This is one reason the system prompt must stay stable and per-turn data goes into `<context>` (D47).
- **No shutdown tail:** a turn ends as soon as its stop signal fires; sessions are not persisted (`persistSession: false`).
- **Work before the window closes:** recall starts when the message is accepted; read receipt and typing indicator run in parallel with preparation.
- **Fewer steps:** independent tools in one step, `end_turn` as the last call in the step with the last message.
- **Thinking per role** lives in `src/config/models.ts` and changes only after an eval. Lower thinking made the chat measurably worse at style, so chat stays at the default.
- **Recurring queries go directly to Postgres** (addendum D50 of 2026-10-11): anything that runs on its own (scheduler tick, pollers, heartbeat, kill-switch reads) uses one persistent connection as role `serain_server` (`src/db/pg.ts`, migration `0030_server_role.sql`), never PostgREST, because each REST request costs egress and log volume on the free tier. Every query has a timeout. Turns and tools keep using PostgREST.
- `deploy/deploy.sh` asks the service whether it is busy (`src/health/work.ts`, `/run/serain/work.json`) instead of counting processes, since warm processes are not work.

## 4. Surviving a crash (D52)

A planned restart waits for running work; a real crash (OOM, VM reboot) does not. D52 makes sure no owner message is silently lost and nothing with an effect is silently repeated.

- **An owner message is `pending` until its turn is done** (`messages.turn_status`, migration `0019_recovery.sql`). It becomes `done` when its turn ends (also when it failed and the owner was told), when it was handled outside a turn (kill switch, revoke, approval decision, proposal answer, login code: all call `settleInbound`), or when the kill switch deliberately drops it. A preempted turn books nothing; its successor takes over.
- **On start, leftovers are read before the channel accepts new messages** (`Runtime.leftoverWork`, `resume`, `src/recovery/index.ts`). Each pending message goes through allowlist, kill switch, decisions and queue again, with a hint (never as the owner's words, never into memory): when it arrived and what the interrupted turn already did with effect (`renderActions` from the audit log). A half-done turn is continued, not repeated. Messages older than one day (`RECOVERY_MAX_AGE_MS`) become `abandoned` (`turn_abandoned`).
- **Executor jobs live in `tasks`** and stay `running` until the result turn is done. After a crash they become `interrupted`, the 🔍 tapback becomes ❌, and a turn with a minimal toolbox tells the owner (`interruptedTaskReport`). **Jobs are never silently re-run.** If the result turn fails before any effect, it is retried once after 60 s (`TASK_RESULT_RETRY_MS`).
- **An approval that was executing** is booked `failed` and reported (`approval_interrupted`), never re-executed: nobody knows whether the mail left.
- **Automatic retry after an error** (addendum D52 of 2026-10-10): if a turn on an owner message fails **without effect** (`TurnProgress.committed` is false), the owner hears a short "retrying in 5 minutes", the message stays `pending`, and the turn runs again after `TURN_RETRY_MS` (`onMessageTurnError`, `parkTurnRetry`, `fireTurnRetry`, audit `turn_retry`, hint `retriedNote`). Only a first run gets a second one. A restart reads `turn_retry` from the audit log and parks the message until the same time. The kill switch cancels the waiting run.
- **Retry when the answer did not arrive** (addendum D52 of 2026-10-13): if the channel failed to deliver a reply (`SendOutcome.undelivered`, `TurnState.noteUndelivered`, `TurnProgress.undelivered`), the model is told not to resend, the turn ends, and it runs again after `TURN_RETRY_MS` with `undeliveredNote`: what arrived is in the history, what was done is listed as `[done: …]`, do not do it again. No "something broke" message is sent, since it would use the same broken line.
- **Deliberately not covered:** turns without an owner message (heartbeat, mail trigger, watchers) are not replayed; they arise again on the next tick. A durable queue framework was rejected: every replayed event would still need the per-kind decision of whether it still makes sense, which is exactly what the code decides here.

## 5. Steering a running turn (D57)

When the owner writes while a turn is running and that turn has already committed (D50), the message is handed **into** the running turn instead of waiting for a second one.

- **Where:** in the queue, at the same point where a message would otherwise be collected, i.e. after allowlist, kill switch, revoke, decisions, proposals and code interception (`RunControl.setSteerer` in `src/security/queue.ts`). Only message turns, never event turns, never recovered messages, never past a message already waiting behind the turn.
- **Only into a clean turn.** Once a turn has seen foreign content, it accepts nothing more, and accepted but undelivered messages go back. A separate turn afterwards may do everything that needs the owner's direct authority; the tainted one may not.
- **How the model sees it:** the registry appends it as `<addendum message_id="…">` to the next tool result (`Steering`, `TurnState.deliverSteers`). One mechanism for both SDK paths, so the code knows exactly what the model received and when. Voice messages are transcribed first, images wrapped; an image's taint applies from delivery.
- **When it counts:** only once the model starts a new response (`noteResponse`: `message_start` on the Agent SDK path, `prepareStep` on OpenRouter). Only then are the words added to `ownerWords` (a `namedByOwner` proof for a tool planned before cannot see them, one after can), the message ID becomes a valid tapback target, and the turn owes an answer to it.
- **No ending across it:** while an addendum is ready or delivered but unseen, `end_turn` does not count (`mayEnd`, denial `steer_unseen`); the model gets the addendum instead. On the OpenRouter path the loop ends only via the turn's own signal.
- **Nothing is lost:** whatever the turn did not see (it ended, kill switch, error, unreadable attachment) is given back (`giveBack`) and runs immediately afterwards as its own turn, ahead of anything newer. Seen messages are booked `done` with the turn (D52); memory learns from all words together.
- Audit: `turn_steered`, `turn_steer_returned`, `tool_denied` with `steer_unseen`. Tests: `test/steering.test.ts`, `test/queue.test.ts`.
- **Rejected:** feeding the message into the SDK's streaming input with `priority: "next"` (timing not observable from outside, a second mechanism for the fallback, warm processes would need streaming input); accepting and booking at the end (silently lost whenever the model was just finishing).

## 6. Fuzzing at the trust boundaries (D53)

Fuzzing with `fast-check` lives in `test/fuzz/`. `pnpm test` runs a fixed seed in seconds; `pnpm fuzz` runs 2,000 cases per property (`FUZZ_RUNS`); `FUZZ_SEED` reproduces a reported failure.

- **Generic, so every new service is covered without new test code.** Runtime and harness build connector drivers through the same function `connectorDrivers` (`src/connectors/drivers/index.ts`). Every catalog service and each of its tools runs through the runtime path against a fake provider that only distinguishes protocols (JSON-RPC as MCP server, everything else as HTTP/JSON), with arguments generated from the tool's Zod schema. The test fails if a catalog service has no driver or a provider is never reached. Likewise every `…Tools` factory is discovered and matched against every `defineTool` in the source; each tool gets its real declaration with a hostile handler.
- **Invariants:** no crash; termination in bounded time; bounded results; foreign content wrapped exactly once and tainted, also on exceptions; `privateResult` never in the audit log; no audit entry above 20,000 characters; Photon frames never break the stream; the allowlist never lets through a group or a foreign number (against an independent oracle); parsers on foreign text stay linear (no ReDoS); approvals never execute twice, early, after cancellation or with a different mailbox; link previews only to opened public pages; sending over Photon never produces a duplicate.
- **Every tool call has a time limit** (`TOOL_TIMEOUT_MS`, 120 s, or `timeoutMs` on the tool), found because a hanging tool used to freeze turn and queue forever. The model is told the outcome is open and must not blindly retry.
- **Not covered, deliberately:** an overall limit for the model call itself, connection setup (OAuth, bank session), end-to-end mail/calendar/Mac handlers (covered via their parsers and the registry), homoglyphs in the wrapper tag, `src/browser/*`.

## 7. Playbooks and login codes (D56)

**Playbooks** (`src/agent/playbooks.ts`) are built-in procedures for kinds of requests: scheduling, travel, commuting, research on money/health/law, privacy and spam, cancellations and consumer rights, passenger rights, suspicious mail, and "on its own" (unasked birthday reminders and reply watchers).

- They are selected by keyword regex in code (`pickPlaybooks`, at most two per turn), not by embedding similarity: the triggers are testable and cost nothing.
- They appear only in the `<context>` of a matching turn, as `<playbook source="builtin">`, after the owner's own approved procedures, never in the system prompt (D47). A playbook may name memory areas and recall terms; `buildMemoryContext` then pulls matching facts.
- **A playbook grants no right and contains no security rule and no style.** It is text in the context and never reaches the registry. Limits it describes (e.g. "unasked only from the owner's own words") are enforced in code elsewhere (`src/security/unasked.ts`). An owner procedure takes precedence.

**Login codes for logged-in sessions** (`src/sites/codes.ts`, `Runtime.onCode`): when a vault-backed session needs an SMS or app code during login, the code asks the owner with a fixed sentence. The answer is intercepted in `onInbound` after the allowlist and **before storage**, by regex, only while a login waits (plus ten minutes). A placeholder is stored instead, the audit log records only the site, and the code goes straight into the field after re-checking the host. **The model never sees it.** Only one request at a time; only `run_site_task` (level 3, owner-only, clean) can trigger it, so a mail or page cannot make Serain ask for a code.

**Disruptions and setup hints:** what is currently broken appears as `<disruptions>` in `<context>`, from process memory without a query; how to connect a missing integration is stated in the system prompt (`setupLines` in `src/agent/prompt.ts`), because that changes only when something is connected.

---

## 8. Languages

Serain answers in the language the owner writes in, any language. The model handles that by itself; everything that reaches the owner **past** the model, and everything the code reads **from** the owner, needs code. The developer guide with the API, the rules for new texts and the full list of prompt tags is [`src/i18n/README.md`](../src/i18n/README.md).

- **Which language is current** (`src/i18n/language.ts`). `OWNER_LANGUAGE` (BCP 47, default `en`) is only the start. Every owner message is checked after the allowlist and after login-code interception, never foreign content, with `eld` (a small, pure-JavaScript detector). Hysteresis: short messages ("ok", an emoji, a link, `serain stop`) change nothing; a clear message of four words or more switches at once; a three-word message only when the next readable one agrees. The result lives in `agent_state.owner_language`, so a restart keeps it.
- **Prompts are English.** System prompt, tool descriptions, tool results, `<context>` blocks and event texts are written in English, and the prompts tell the model to answer in the owner's language. Nothing the model reads is translated by code.
- **Fixed texts** (preview frames, confirmations, kill-switch replies, greetings, health, budget, recovery and reminder notices) live in a catalog (`src/i18n/catalog.ts`, one file per module in `src/i18n/messages/`) and render through `t()`. English and German are built in. For any other language the model translates the English catalog once (with the German as tone reference), each line is checked in code (same placeholders, all plural forms of the language, no new digits, links, markup, dashes or line breaks, a length bound), and accepted lines are cached in `agent_state` as `catalog:<lang>`. Until then, and for every rejected line, the owner reads English. Only the fixed catalog ever goes into a translation request (D8): **content is a placeholder and stays verbatim** in every language: recipients, mail text, subjects, amounts, names, titles. Dates and numbers come from `Intl` with the owner's locale and time zone.
- **Words the code reads** (`src/i18n/words.ts`, lists in `src/i18n/messages/words.ts`): consent in a preview's thread (`yes`, `no`, `always`) and the codewords after "serain" (`stop`, `resume`, `revoke`). Accepted is always the union of English, German and the current language (its words come from the checked translation); 👍 and 👎 work in every language. A word that is both yes and no counts as no; among codewords stop beats revoke beats resume. Only a whole message is a decision. Changing a word list changes what counts as consent and is reviewed against D8.
- **Fail closed in other languages.** Safety checks that depend on words (proof that the owner named a target for `namedByOwner`, purchase and submit buttons in forms and logged-in sessions, negations, "yes, but tomorrow at 8") have word lists or grammars for English and German only. In any other language they take the safe side: always the preview, no shortcut, mask rather than show, a time is conversation. Language-neutral signals (digit patterns, emoji, HTML attributes such as `type=submit` or `autocomplete=cc-number`) are preferred where they exist.
- **Voice.** whisper.cpp detects the spoken language itself (`-l auto`, D21). Spoken replies (D59) use a local Piper voice for de, en, es, fr, it, nl, pl, pt, ru and tr; the hosted Fish voice only for languages listed in `SPEECH.voices` (`src/config/models.ts`). Without a voice for the language the reply is sent as text.
- **Stored data** (facts, user model, lessons, stored previews) keeps the language it was written in; the model reads any language. Standing approvals are stored as structured keys and put into words only when shown. Full-text search uses the language-neutral configuration `serain_text` (migration `0035`), which stems nothing and drops only English and German stop words; embeddings carry meaning across languages.
- **Adding a language** needs no code for texts: the catalog translates itself on the first switch. A new language for a word-dependent safety check is a word list in that module, reviewed against D8. A new local voice is three entries that a test keeps in sync: `PIPER_VOICES` in `deploy/sandbox/Dockerfile.tts`, `VOICES` in `deploy/sandbox/helper.mjs` and `PIPER_VOICES` in `src/media/speech.ts`. A hosted voice is one line in `SPEECH.voices`. Public holidays exist for Germany only (`src/holidays.ts`, `OWNER_COUNTRY=DE`, `OWNER_REGION`).

---

## Decision register

One entry for every decision number referenced in the code. Numbers not listed here (D1, D5, D17, D18, D22, D27, D60) are not referenced in the source code; D17, D18 and D27 are briefly mentioned where relevant above and below. Addenda ("addendum D… of DATE" in code comments) are listed under their decision with that date.

<a id="d2"></a>
### D2: Channel behind an interface

iMessage is reached through a `Channel` interface (`src/channel/types.ts`) with `send`, `react`, `reply`, `typing`, `onInbound`, and capabilities declared per adapter. Rule used throughout the code: **a capability or no tool/parameter**: if the channel cannot do something (tapbacks, editing, previews, voice), the tool or parameter does not exist instead of failing at runtime. The concrete provider choice was superseded by [D38](#d38).

<a id="d3"></a>
### D3: Model layer

Primary path is the Claude Agent SDK; a paid OpenRouter path is the automatic fallback on rate limits or outages, behind one abstraction (`src/agent/model.ts`). The model per role lives in `src/config/models.ts`, never hard-coded, and changes only after an eval (`pnpm eval`). **Only zero-data-retention providers**: one policy with `zdr: true` and `data_collection: "deny"` for fallback chat, structured output, embeddings and evals (`test/model-openrouter.test.ts`). Every paid request is booked in `usage_log` against a monthly cap; sums are computed in SQL. *Addendum D3 of 2026-10-08:* from 80 % of the API cap Serain is throttled (smaller `saver` model on the paid path, no heartbeat or morning briefing), at 100 % no paid calls and no jobs; a budget line appears in `<context>` from 50 %. With an Anthropic API key the chat counts against the cap too and stops at 100 %; only with the subscription token does it keep running (`chatStops` in `src/budget.ts`). Rejected: providers without ZDR regardless of price.

<a id="d4"></a>
### D4: Two layers, context per turn

A chat layer with a small style prompt and an executor for background jobs with its own tools (see [Overview](#two-agents-one-registry-each-d4-d16)). Context is rebuilt per turn from the database instead of an endless session. Messages are tools; long jobs get an immediate acknowledgement and the result later as a thread reply. History lines carry time markers so the model can tell old answers from new ones.

<a id="d6"></a>
### D6: Memory in layers with provenance

`messages` (every message, with taint and embedding), `facts` (with source message, kind, validity, area, `superseded_by`; corrections replace, never silently overwrite), rolling `summaries`, and a versioned user model (base text written by the owner plus a learned part). Provenance makes memory auditable and allows real deletion.

<a id="d7"></a>
### D7: Own integrations, no aggregators

Integrations use the owner's own OAuth apps, MCP servers and direct protocols. Token custody never goes to a third-party aggregator, because the agent holds mail and later payment rights. Optional local tools come from the Mac companion ([D28](#d28)).

<a id="d8"></a>
### D8: Security principles

Ingress allowlist, kill switch, four tool levels with confirmation, foreign content as data, secrets out of prompts, append-only audit log, sandbox, limits, separation. See [chapter 2](#2-security-model-d8). Point numbers used in code: D8.1 allowlist, D8.2 kill switch, D8.3 levels, D8.4 foreign content, D8.5 secrets, D8.6 audit, D8.7 sandbox, D8.8 limits.
- *Addendum D8.4 of 2026-10-02:* outbound messages keep the taint of their turn and are wrapped in later history; summaries and fact extraction drop them.
- *Addendum D8 of 2026-10-03:* no preview when the code proves the owner named the target (`namedByOwner`, `approval_waived`).
- *Addendum D8.4 of 2026-10-08:* denied owner-only/clean-only tools are deferred to a clean follow-up turn; links to the owner after foreign content need a page a tool opened.
- *Addendum D8 of 2026-10-10:* a late 👍 on an expired preview re-issues it; execution needs a new 👍.
- *Addendum D8.4 of 2026-10-12:* the home page of a DMARC-verified, known sender domain may be linked.
- *Addendum D8 of 2026-10-13:* `calendar_delete` without guests and `run_site_task` with a named site skip the preview; the rule for when previews exist.

<a id="d9"></a>
### D9: Proactivity

A `schedules` table with a 30 s poller, and an hourly heartbeat whose default is silence. Proactive messages are bundled and capped per day. Reminders must never fire early (tested across DST changes), repeats are computed from the intended wall time, and every executor result is reported, even an empty one (`reportOwed`). `overview` lists everything that is running for the owner.

<a id="d10"></a>
### D10: Operations

One long-lived Node process under systemd on a disposable server; data lives in Supabase, so the server can be rebuilt any time. **No ingress except SSH**: the channel and all integrations connect outward; a webhook would need an explicit decision. Secrets in a root-owned env file; the agent host gets no rights on the cloud account (a compromised agent must not delete or create servers). Deploy via `deploy/deploy.sh` (typecheck, tests, rsync, restart). A health heartbeat and an external deadman ping report outages.

<a id="d11"></a>
### D11: Tool layer

One definition for both SDK paths (see [Overview](#a-tool-is-defined-once-d11)). A turn ends with tool calls; if the model only produces text without `end_turn`, the text is sent anyway (`turn_text_fallback`), because silence is worse. All tools of a step run in call order, then `end_turn` takes effect (`TurnState.requestEnd`, `runSerial`). Per-turn caps apply immediately. Built-in SDK tools are disabled four ways (`tools: []`, `disallowedTools`, `strictMcpConfig` plus no setting sources, `canUseTool`). Levels 3/4 fail closed without the confirmation protocol. While an owner turn has not yet reached the owner, every tool result carries a fixed reminder that only messaging tools reach him (`owner_unanswered`).

<a id="d12"></a>
### D12: `judge`

Small typed decisions (`boolean`, `choice`, `score`) with a probability, behind one interface with two backends (`src/agent/judge/`): a generative one via the model layer and Typesafe's Jev via OpenRouter. Fallback to the next backend is logged. **`judge` decides attention and memory, never security:** levels, approvals, the allowlist and confidential-value checks stay deterministic. A tool whose justification is the owner's instruction in the same turn (like `forget_fact`) must be owner-only.

<a id="d13"></a>
### D13: Memory write path and forgetting

After each owner turn, asynchronously: a `judge` gate, then extraction by a small model, then classification against similar facts with thresholds (≥ 0.8 supersede, 0.45–0.8 keep both and note a question if a wrong assumption would be costly, below: new fact). **Only the owner creates facts**; foreign content never writes memory. `forget_fact` is `write_reversible` because it deletes only Serain's derived knowledge on the owner's direct instruction, and is therefore `ownerOriginOnly`; it hard-deletes the whole replacement chain and affected summaries, and the audit log keeps only that something was deleted. Recall combines vector and full-text search with reciprocal rank fusion; current situations always appear as `<current>`.

<a id="d14"></a>
### D14: Confirmation protocol

The preview is code, the decision is regex. See [2.3](#23-tool-levels-and-the-confirmation-protocol-d83-d14). Rejected: letting the model repeat the call after approval and comparing hashes (a whitespace difference would cause a second preview and train the owner to wave things through). *Addendum D14 of 2026-10-08:* "yes, but tomorrow at 8" schedules exactly the approved call (`src/security/later.ts`, English and German grammars); never money, files or repeats; cancelled by a no word, 👎, `cancel_schedule` or the kill switch; at most 30 minutes late, otherwise `missed`. *Addendum of 2026-10-13:* previews are a short question with bullet lists and brand names, the way back in one sentence, and everything that matters still shown.

<a id="d15"></a>
### D15: Scheduler

Two kinds, deliberately separate: a **reminder** (`set_reminder`) is fixed text sent verbatim, with no model; a **scheduled job** (`schedule_task`) becomes a turn of origin `schedule` without owner-only tools or standing grants. `schedule_task` and `cancel_schedule` are owner-only, because a stored job is text Serain will later read as an instruction (prompt injection with a timer). The model gives wall time in the owner's time zone; offsets are computed in code (`src/time.ts`). Repeats by keyword (`daily`, `weekdays`, `weekly`, `monthly`, `yearly`) anchored to the intended wall time. Failed deliveries back off (1, 5, 15, 60 min) and missed one-off reminders are delivered later (`src/scheduler/missed.ts`). After a crash, reminders are re-sent (better twice than never, duplicates suppressed) but jobs are never repeated.

<a id="d16"></a>
### D16: Executor

Background jobs with read-only tools; the report is foreign content. `run_task` checks budget and capacity before setting 🔍 (acknowledge only after the precondition check, W22), is `cleanTurnOnly`, and runs beside the queue (at most two at once). `web_fetch` has SSRF protection at the socket. Search goes through a `SearchProvider` with its own monthly cap. The last step belongs to `finish_task`. *Addendum of 2026-10-10:* side findings and an action page are kept only if a tool opened that page; structured page data (JSON-LD) is read; public holidays are noted; a failed result turn is retried once. Rejected: the SDK's built-in web search (results would bypass registry, audit and taint).

<a id="d19"></a>
### D19: Heartbeat

Code first, model second, and never a text fallback. Silence rules live in code (`decideHeartbeat`): no messages at night, none within 30 minutes of the last message, a daily cap, nothing during the kill switch, and only when there is a concrete occasion; most hours end without a model call. The heartbeat turn has exactly `send_message`, `cancel_silently`, `end_turn`; `cancel_silently` exists only for `heartbeat` and `schedule` origins (in an owner turn it would be a way to ignore him). *Addendum D19 of 2026-10-10:* the "failed schedule" occasion was removed (reminders are now delivered late instead).

<a id="d20"></a>
### D20: Sandbox

A root-owned helper (`deploy/sandbox/helper.mjs`) behind a Unix socket, run by its own user in the `docker` group; the Serain service is not in that group. It knows a fixed list of named jobs (`python`, `node`, `audio_to_text`, `image_to_jpeg`, `compute`, `pdf_to_text`, …) and runs each with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, as nobody, with limits; no client value reaches the command line. Media parsers (ffmpeg, ImageMagick, poppler) run here too, because they parse files from the internet. Rejected: putting the service in the `docker` group (root-equivalent), rootless Podman (would require weakening the systemd hardening). *Addendum D20 of 2026-10-09:* PDFs from the web are converted to text in the sandbox; without a sandbox they are refused.

<a id="d21"></a>
### D21: Images and voice messages

Attachments become text before the turn; the chat turn stays text-only. Every file goes through the sandbox first (re-encoded JPEG without metadata, local whisper.cpp transcription that detects the spoken language itself; nothing is opened in-process). **A voice message is the owner's words; an image is foreign content** (it can carry text the owner never noticed): the description is wrapped, taints the turn and never becomes a fact. The price, accepted: "here is the poster, find me tickets" takes two messages.

<a id="d23"></a>
### D23: Style round

The style block is changed only in a dedicated style round with the owner, never in passing; measured with the chat eval. *Addendum D23 of 2026-10-08:* tapbacks are **signals** named by the model and mapped to emoji in code (`src/channel/signals.ts`: `ok` 👍, `love` ❤️, `haha` 😂, `scheduled` ⏰, `watching` 👀; only code sets `working` 🔍, `done` ✅, `failed` ❌); values to copy go as separate verbatim bubbles (`copy`); fixed texts for budget, scheduled approvals and others; unasked previews or screenshots of the most important opened source. *Addendum D23 of 2026-10-10:* fixed texts for integration outages, kill switch, interrupted jobs, late reminders and lesson offers. *Addendum of 2026-10-13:* dashes are replaced in code before sending (`withoutDashes` in `src/text/format.ts`). New signals and new fixed texts to the owner belong to a style round.

<a id="d24"></a>
### D24: Owner tapbacks are signals

The meaning lives in a table, not in the model: 👎 on a Serain message is a correction, ❓ means "I don't understand or believe this", everything else is an acknowledgement. 👍/👎 on an open preview are decisions (D14) and never reach this path. Corrections run as origin `owner_reaction` (no owner-only tools); the quoted message cannot be sent again verbatim (`OutboundGate.forbidRepeat`). Acknowledgements appear in history as `[tapback from …]` from the audit log.

<a id="d25"></a>
### D25: Typing indicator

If the channel reports that the owner is typing while a message is buffered, the turn is postponed (capped at 25 s). Ephemeral, no audit, still behind the allowlist. The current channel does not deliver the signal; the capability stays in the interface as optional.

<a id="d26"></a>
### D26: Probation after a behaviour change

`PROACTIVE_BEHAVIOR_VERSION` counts changes to when or about what Serain speaks up on its own. After a change, three days of probation in which only high-priority occasions get through; a 👎 on a proactive message restarts it. `test/heartbeat.test.ts` fingerprints prompt, occasions and tools and fails if they change without a new version.

<a id="d28"></a>
### D28: Mac companion

An optional process on the owner's Mac (`companion/`) with read-only Apple calendar, reminders and contacts plus a headless Chrome behind a filter proxy. Reachable only through an SSH reverse forward to a loopback port on the server; the tunnel user has no shell and may bind only that port. The companion trusts the server as little as the reverse: fixed tool list, own token, own limits, rejects browser-origin requests. Apple data belongs to the chat (not the executor) and is `returnsUntrusted`, because anyone can put a titled invitation into a calendar. The executor gets only `mac_browser`.

<a id="d29"></a>
### D29: Confidential values never leave the server

A deterministic filter on `run_task` and on every outbound path of the executor (`src/security/confidential.ts`, `src/memory/confidential.ts`): street addresses, numbers with seven or more digits, mail addresses from memory and any valid IBAN; also URL-decoded forms. The model only learns the kind of finding and reformulates. Fail closed if memory is unreadable. Deliberately coarse; names and paraphrases are not covered and stay a prompt rule. Rejected: only sharpening the prompt (it had failed), silently redacting, `judge` as checker.

<a id="d30"></a>
### D30: Credentials

Sealed with AES-256-GCM in `integrations`; the key exists only in the environment. Connecting runs on the owner's machine (`pnpm integration connect …`, hidden input, OAuth with PKCE) and verifies before storing. Tools get connected objects, never secrets (surrogation, W16). Disconnecting revokes at the provider where possible, deletes the credential and cascaded data, and takes effect immediately in the running process (W13). Mail content is never written to the audit log (`privateResult`).

<a id="d31"></a>
### D31: Mail

Provider-neutral `MailAccount` with an IMAP/SMTP adapter and a Gmail REST adapter; the first connected owner mailbox is the default. Reading belongs to the chat, is `returnsUntrusted`, and narrow per call (W3: at most 10 mails, 90 days, 7 days without sender or keyword, text truncated). One-time codes and login links are masked before any model sees them; `mail_code` releases a code only owner-only, clean, from the last 15 minutes, never into the audit log. *Addendum D31 of 2026-10-03:* search covers every folder. *Addendum D31 of 2026-10-08:* Serain's own mailbox: never the default, only with `account: serain`, own standing grants, no cleanup, ownership stored inside the sealed credential. *Addendum D31 of 2026-10-12:* `mail_attachment` opens PDFs and images only in the sandbox; everything else stays closed.

<a id="d32"></a>
### D32: Google

Own OAuth app; Gmail via the REST API (never IMAP, which would need full delete scope); new mail via the History API polled every minute (no push, which would need a webhook or a cloud project). Calendar level depends on guests (W1), verified against the real event; times are sent as wall time plus time zone.

<a id="d33"></a>
### D33: Mail trigger

Code first, then `judge`, then a model. Own mails and bulk mail are filtered by header at no cost; the rest is classified by `judge` (below 0.6 means nothing); only what remains gets a summary. `judge` decides attention, never rights; the reporting turn has origin `untrusted` and three tools. Reports are bundled and capped. *Addendum D33 of 2026-10-08:* classification rules in `src/mail/rules.ts` (important only if a personal action or real deadline is required) and a separate mail eval. *Addendum D33 of 2026-10-10:* bulk (list headers) and automated mail (`Auto-Submitted`) are separate; bookings are offered via `calendar_offer` (level 3, 24 h preview), deadlines come via the heartbeat, already-answered threads are not reported. *Addendum D33 of 2026-10-13:* sender trust (`known`/`new`/`unverified`) is computed in code; replies to mails Serain sent are always reported, recognised only by header (`mail_sent`); awaited mails announced with `expect_mail` are always reported; a promise in Serain's text without anything that keeps it blocks the turn once (`promise_unheld`).

<a id="d34"></a>
### D34: Messages to third parties

Mail only, level `irreversible`, preview with every recipient and the full text; standing grant only for exactly one recipient without Cc. **No iMessage to third parties**: the allowlist would drop their replies and it risks the shared number. *Addendum of 2026-10-02:* the preview warns about recipients that never appeared in mail, contacts or chat (`src/mail/recipients.ts`). *Addendum D34 of 2026-10-08:* `mail_send` attaches files the owner sent via iMessage; they live only in memory (`src/files/shelf.ts`, one day), the ID is a checksum, attachments always need a preview and are sent into the preview thread.

<a id="d35"></a>
### D35: Browser for public pages

Chrome on the server with a throwaway profile, Chrome sandbox on, every connection through the filter proxy, no downloads, no password fields; URL, goal and typed text pass the confidential filter. Jev acts as pilot and sees only public page text (no ZDR at that provider), never logged-in sessions. Bot detection is recognised, never circumvented; when a site blocks, the executor uses another source.

<a id="d36"></a>
### D36: Logged-in sessions

Sessions with credentials from the vault, where the code fills username, password and TOTP only on the entry's hosts, and the model never sees a secret. Main-frame navigation is pinned to the entry's hosts. Triggered only by `run_site_task` (`irreversible`, owner-only, clean, no standing grant), steered by the executor via the subscription model, never Jev. Sessions fetch information only, with a button blocklist (buy, order, book, pay, cancel, delete); acting is possible only through the form path of [D63](#d63).

<a id="d37"></a>
### D37: Mailbox cleanup

Unsubscribe via the `List-Unsubscribe` header (one-click RFC 8058 through the network guard, or a single-recipient `mailto:`), move instead of delete; **nothing is ever permanently deleted**. `unsubscribe`/`trash` touch only bulk mail of the exact address; `spam` moves all mail of an address and is capped. The preview counts the mailbox itself. A keep list (`src/mail/keep.ts`) is enforced by code. `mail_spam_folder` empties the spam folder into the trash and rescues named senders; **nothing is ever unsubscribed from the spam folder**. From 13 senders the preview is a summary. *Addendum D37 of 2026-10-03:* unsubscribe routes are searched in other folders; without a header the server browser opens the unsubscribe link from the mail, chosen by code (never the model), never from spam, Jev sees no address, done only when the page confirms. *Addendum D37 of 2026-10-10:* only list headers count as bulk, so tickets stay. *Addendum D37 of 2026-10-13:* Gmail cleans up via labels, only if the credential carries `gmail.modify`, paced against Gmail's per-minute quota.

<a id="d38"></a>
### D38: iMessage via Photon

The channel adapter uses Photon's free tier through its SDK Spectrum (`src/channel/photon/adapter.ts`): an outgoing gRPC stream keeps D10 intact (no inbound port), texts, threads, tapbacks, read receipts, attachments and rich links work. The shared line can only write after the owner has written to it once. There is no monthly message quota; the outbound rate limit stays. The channel is treated like a foreign server for confidentiality: long-lived secrets never go over it. *Addendum D38 of 2026-10-13:* texts go past Spectrum through Photon's own SDK with a `clientMessageId` and are retried once after `[upstream]` UNAVAILABLE; `ALREADY_EXISTS` proves delivery, so no duplicate is created. Formatting and edits use Photon's own fields.

<a id="d39"></a>
### D39: Fact kinds and validity

Four kinds (`identity`, `preference`, `situation`, `episode`) and `valid_from`/`valid_until`, validated in code. Time-limited facts overlay instead of replacing; future facts end the old one on their first day. Recall hides expired facts; forgetting still finds them.

<a id="d40"></a>
### D40: Living user model

Versioned in `user_model_versions`: the owner's base text (the machine may only strike whole lines) plus a learned part written by a nightly consolidation, which runs only if facts changed and is checked in code before activation (headings, length, at most five struck lines). Forgetting reaches into the user model and deletes older versions containing the struck lines; forgotten words are remembered only as HMACs so consolidation cannot reintroduce them.

<a id="d41"></a>
### D41: Searchable history

`messages.embedding` is filled after each turn; `search_history` is hybrid (vector plus full text). Messages Serain wrote after foreign content appear wrapped in the result. Summaries are chosen by relevance, so the confidential filter reads all of them.

<a id="d42"></a>
### D42: Proposals and approved procedures

Only what the owner confirms becomes memory. Lessons from a 👎 plus correction are collected and offered weekly; procedures can be proposed after a successful multi-step task (`propose_procedure`). Decisions on proposals are parsed by regex. Procedures appear in `<context>` as `<procedures>` only when relevant and **grant no rights**: they are text and never reach the registry.

<a id="d43"></a>
### D43: Watchers without a model

Fixed types (`url_value`, `status_changes`, `mail_arrives`, and since *addendum D43 of 2026-10-08* `quote` with fixed sources per asset class). The poller compares numbers or fingerprints, never text; a model runs only on a confirmed hit, as an `untrusted` turn with three tools. Created only from a clean owner turn (`watch_create` is owner-only and clean-only); the start value is parsed by code and does not taint. Model-written scripts were rejected (a recurring injection with a timer). *Addendum of 2026-10-10:* expiry is reported with min/max values; transient source errors back off instead of disabling the watcher.

<a id="d44"></a>
### D44: Delivery as a health component

The `OutboundGate` counts what `channel.send` throws. Three failures in a row or ≥ 50 % of at least four attempts in 30 minutes means unhealthy; healthy again only after the next success. The heartbeat opens an incident and fails the external deadman ping, because the only channel to the owner is the broken one.

<a id="d45"></a>
### D45: Memory eval

`pnpm eval:memory` runs the real write and recall pipeline (real `judge`, extraction, embeddings, `forget_fact`) per case against a fresh PGlite database with all migrations; never against the production database. Compare before and after a change, repeat runs before deciding.

<a id="d46"></a>
### D46: Proactive occasions and morning briefing

The code finds the occasion (a deadline today or tomorrow, a change by others, a collision), the model almost always decides to stay silent. Calendar titles and places are foreign content and taint the turn. High priority passes probation and may exceed the daily cap once. *Addendum D46 of 2026-10-14:* no more travel occasion ("an event with a place starts within 90 minutes", in the morning look "before 10:00"). It only knew that the event has a place, which is in the owner's own calendar; the model filled the gap with guesses from memory about where the owner works that week, which the owner knows best. A way-there hint only comes back with real data on the way (traffic, cancellations) and only when it changes something.

<a id="d47"></a>
### D47: Stable system prompt

The Agent SDK caches the system prompt as a whole. Everything that changes per turn (time, memory, playbooks, disruptions, calendar refs) goes into `<context>` before the latest message; the system prompt holds only rules, style, protocol and the user model.

<a id="d48"></a>
### D48: Formatting, effects, editing

Bold, italic and strikethrough are real formatting (`prepareOutbound`, `styledBubble` in `src/text/format.ts`); the style allows bold at most once per message. At most one effect per turn. `edit_message` can change only messages sent by the messaging tools (`messages.raw.editable`), never a preview, and is owner-only. *Addendum D48 of 2026-10-08:* link previews and screenshots as described in [2.4](#24-foreign-content-and-taint-d84); screenshots only in memory, only to the owner via `send_file` with `kind: screenshot`; `screenshotBlocker` blocks shots of logged-in pages that show credentials or codes. *Addendum D48 of 2026-10-10:* the watcher poller counts as opener of exactly the page its fetch loaded.

<a id="d49"></a>
### D49: Web interface and vault on the server

A Cloudflare Worker (`web/`) with tabs for audit, memory, vault and connections. Cloudflare Access is never optional and is verified by the worker itself (`web/src/access.ts`); login only by passkey (`web/src/auth.ts`). The worker talks to Postgres as role `serain_web` (only views and specific functions), never with the service key, and only via Hyperdrive or loopback with verified TLS. Vault entries and files are **sealed in the browser** to the server's public key (`src/vault/sealbox.ts`); the interface can create, replace and delete but never read; the server uses only what is inside the sealed payload. Photos lose metadata in the browser. *Addendum D49 of 2026-10-08:* vault files; Serain fetches them with `vault_file` only on the owner's request, to him or as a `mail_send` attachment. What appears in the audit tab is decided by the view `web_audit`.

<a id="d50"></a>
### D50: Response time

See [chapter 3](#3-response-time-d50). *Addendum D50 of 2026-10-11:* recurring queries over direct Postgres as `serain_server`.

<a id="d51"></a>
### D51: Connections in the web interface

The browser initiates, the server completes, both meet only in the database (no open port, no tokens in the worker). OAuth with PKCE and dynamic client registration, issuer fixed per driver, tokens sealed in `connectors`. **Tools, levels and descriptions come from our catalog** (`src/connectors/catalog.ts`), never from the provider (no tool poisoning). Results are `returnsUntrusted` and `privateResult`, reading happens only in the chat, writing only `ownerOriginOnly` and `cleanTurnOnly`. A new service is one catalog entry plus one driver in `src/connectors/drivers/`. Rejected: handing MCP servers directly to the Agent SDK (levels would come from the provider, the fallback would lack them, D11 would be bypassed). A service only one owner uses goes into their instance ([D64](#d64)).

<a id="d52"></a>
### D52: Surviving a crash

See [chapter 4](#4-surviving-a-crash-d52). *Addendum D52 of 2026-10-10:* one automatic retry after 5 minutes when a turn failed without effect. *Addendum D52 of 2026-10-13:* the same when the answer was not delivered, with a hint about what was already done.

<a id="d53"></a>
### D53: Fuzzing

See [chapter 6](#6-fuzzing-at-the-trust-boundaries-d53). *Addendum of 2026-10-13:* sending over Photon is fuzzed for duplicates and wrong channel IDs.

<a id="d54"></a>
### D54: iCloud calendar via CalDAV

A third credential type `caldav` (Apple ID plus app-specific password, sealed). When iCloud is connected, the `calendar_*` tools belong to it, otherwise to Google; two write targets would mean guessing. Serain picks the fitting calendar per event. **No invitations via iCloud** (iCloud would send them itself without preview control). Recurring events via `repeat`; writes carry the ETag so concurrent edits fail visibly. *Addendum D54 of 2026-10-10:* overlaps are reported with times only, never titles; the place of an event can be passed to the executor by reference (`event_id`, `src/calendar/refs.ts`), wrapped as foreign content and coarsened by the confidential filter. *Addendum of 2026-10-13:* overlaps are checked before creating; a deliberate second entry needs `despite_overlap`.

<a id="d55"></a>
### D55: Broken integrations, follow-ups, open items, files, subscriptions

Integration outages are reported after 20 minutes, once, with a code-written sentence (incidents `integration:<id>`), and expiring grants are announced a week ahead. `report_if_none` on mail watchers reports when nothing arrived. `mail_open_items` reads stored summaries, never mail text. `send_file` creates `.ics`, vCard and PDF from fields in code (no bytes from the model or the web). `bank_subscriptions` detects recurring debits deterministically.

<a id="d56"></a>
### D56: Playbooks, scheduling, research depth, cancelling, codes, setup hints

See [chapter 7](#7-playbooks-and-login-codes-d56). Also: `calendar_free` computes free slots in code with times only (no foreign text); `run_task` with `thorough` makes the executor open at least five primary sources (enforced by code); `cancel_task` aborts jobs (owner-only). Steering was evaluated here and built in [D57](#d57).

<a id="d57"></a>
### D57: Steering

See [chapter 5](#5-steering-a-running-turn-d57).

<a id="d58"></a>
### D58: Calculations in the chat

`compute` runs model-written Python in the sandbox (level `read`, `repeatable`) and does not taint, because its input is what the turn already knows. `compute_files` reads files the owner sent; its output is foreign content and private. Two tools because the input's origin decides the taint, declared on the definition rather than decided in a handler.

<a id="d59"></a>
### D59: Voice replies

`send_voice` sends a voice reply only if the owner's words in this turn contain a voice message or ask for audio (checked against `ownerWords`, never model text). Speech is synthesised locally with Piper in a separate sandbox image (`serain-tts`, one voice each for de, en, es, fr, it, nl, pl, pt, ru, tr); in a language without a voice the reply is text. The tool opens only on the owner's voice message or on audio words in English or German; in other languages it stays closed unless he sent a voice message (comfort, not security). *Addendum D59 of 2026-10-08:* optionally a remote voice (Fish Audio) via OpenRouter with ZDR, only for languages listed in `SPEECH.voices` (`src/config/models.ts`), with daily and monthly caps in code; Piper remains the fallback and is always used when the text contains a confidential value.

<a id="d61"></a>
### D61: Videos and posts

`media_watch` (executor only, `returnsUntrusted`) lets Gemini see video and audio. TikTok, Instagram and X are downloaded by yt-dlp in the sandbox (`media_fetch`, network only through a filter proxy socket, off by default via `SERAIN_MEDIA_DOWNLOAD`), shrunk by ffmpeg without network (`video_compact`), and sent to a ZDR endpoint. YouTube is fetched by Google AI Studio by URL, the one named exception to ZDR (`YOUTUBE_PROVIDER_POLICY`), sending only the public URL and a fixed instruction, never the owner's question. No circumvention of bot blocks, no logins, no crawler impersonation. *Addendum D61 of 2026-10-09:* own step and time budget for videos, `video_search`, a fixed description prompt, structured `picks` rendered by code, PDFs read by the executor can be sent as files or page images.

<a id="d62"></a>
### D62: "Hairpin": return what you find along the way

What Serain notices while doing something else it returns unasked, ready to use (preview, copy bubble, link to the page to act on), with half a sentence saying where it came from, and not if the owner already has it. **Security stays:** a finding from foreign content never writes by itself; it is offered for approval. *Addendum D62 of 2026-10-10:* one shared "whence" rule for proactive messages (`src/proactive/whence.ts`); unasked yearly birthday reminders and reply watchers only from the owner's own words in a clean owner turn (`src/security/unasked.ts`); the booking offer's question is built by code from a fixed vocabulary and the date (`ConfirmSpec.ask`), with an optional check-in reminder for flights.

<a id="d63"></a>
### D63: Building blocks instead of special tools

New capabilities are generic building blocks that grant no right a turn would not already have: missions over several days (`src/missions/`, created owner-only, woken as origin `schedule`, notes carry taint), acting on web forms (`web_form` and `web_submit`, two previews, the code types the owner's data from placeholders, submit only via a held form whose fields must still match, never money), analysis of own data in the sandbox (`analyze_data`, mail headers only, result foreign and private), serial mail (`mail_send_each`, up to ten individual mails with one preview, no standing grant), and playbooks for privacy rights, cancellations and passenger rights. Logged-in sessions may act only through the form path.

<a id="d64"></a>
### D64: One core, one instance per owner

What only one owner needs (a service of their own, their own mail rules) lives in their **instance**, a directory `instance/` outside this repository that the core loads through the alias `@instance/…` with the empty defaults in `src/instance/defaults/` as fallback (`tsconfig.json` `paths`, mirrored in `vitest.config.ts`). The instance only adds to the catalog, the drivers and the mail rules; it never replaces a core module, never changes a level, a guard or a prompt, and its services run through the same registry and fuzz harness (D51, D53). Deployed is a commit of the instance, like the core's. Guide: [INSTANCE.md](INSTANCE.md). Rejected: a fork per owner (two codebases drift apart), loading plugins at runtime from an arbitrary path (the worker and the browser bundle the catalog at build time, and the fuzz harness would not see them).

<a id="d65"></a>
### D65: The public website and the connector directory

serain.si is the project's own page, a second Worker in `site/` next to the web interface, and it never shares an origin with an instance: an instance's web interface runs on an origin of its own (say `app.<your domain>`), its passkeys and cookies bound to that host, and `pnpm site:deploy` refuses while `SERAIN_WEB_ORIGIN` points to the site's domain or an Access application still covers it. The site is static HTML rendered at build time in English and German, with one script from its own origin that decorates (two WebGL shaders over photographs, the drawn conversations, reveals), filters the directory and turns the submit form into steps, and builds no HTML (CSP with Trusted Types); without it every page is complete. The conversations follow the real catalog texts and play the invented owner Alex. The connector directory lists the catalog's services from `src/connectors/catalog.ts` itself, so the page cannot promise a tool or a level the code does not have; every connector has its own page with its tools and levels. **Submitting a connector is an issue on GitHub** (`.github/ISSUE_TEMPLATE/connector.yml`, prefilled by a plain GET form on `/connectors/submit/`, which can only fill the issue form's text fields); a reviewed one is listed from `site/content/community.ts`, and the build refuses levels above `write_reversible`, duplicate names and sources that are not https. Rejected: a submission endpoint with its own database (a public write path with spam, moderation and a second store to secure, for what a connector needs anyway: a code review), a framework for a handful of static pages.

**Found by search engines and AI assistants.** Every fact a crawler or an assistant should take from the site is visible text first; markup only repeats it. The home page ends in questions answered in their first sentence (what Serain is, that it is no app and no hosted service, what it costs, iMessage only, what it may do without asking, how to stop it), and every page carries one JSON-LD graph with the website, Serain as `SoftwareApplication`, its `SoftwareSourceCode` and the maintainer declared once by `@id`, plus the page itself (FAQ, directory as an `ItemList`, breadcrumbs); nothing in it that the page does not say, no rating. Every page has a Markdown twin (`index.md`) built from the same texts, named by `<link rel="alternate">` and a `Link` header and served by the Worker for `Accept: text/markdown`, with the page as canonical. `llms.txt` holds what Serain is, the facts assistants get wrong and links to the twins; the sitemap lists both languages of every page with `hreflang` and the date of the last commit to the content, never the build time; robots.txt lets everyone read, cite and train (`Content-Signal`), because the site describes open source and holds nothing of an owner. The social preview is drawn per language at build time (`site/og.ts`), and `pnpm site:deploy` names the changed pages to IndexNow. Rejected: more programmatic pages for search (thin pages pull the whole site down), facts only in JSON-LD (assistants read the text), a sitemap date from the build (search engines stop trusting it), and blocking AI crawlers (the site exists to be found).

**Counted in the Worker, never in the browser.** The Worker writes one data point per counted request to Workers Analytics Engine (`site/worker/analytics.ts`, dataset `serain_site`): which built page or file, what kind of request (page, Markdown twin, `llms.txt`, robots, sitemap, social preview, missing page), the language, the class of client (browser, search engine, AI crawler, assistant fetching for a person, link preview, other bot) with the name of a known crawler from a fixed list, the host of a foreign referrer and the country. Never the IP, not even hashed, never the raw user agent or a query string, never a path the build did not write; nothing is stored on or read from the visitor's device, so there is no consent banner and no CSP change. It counts views, not visitors, keeps them three months and is read with `pnpm site:stats`. Rejected: an analytics script (Google Analytics, Plausible, Umami, Cloudflare's own beacon), which would need a foreign origin in the CSP, break the rule of one script from the site's own origin and still not see the crawlers and assistants the site exists for; a beacon to the Worker itself (a public write path for numbers the Worker already has).

---

## Other labels in the code (W, V, H)

Comments also reference lessons from an earlier review of comparable products (W…) and from two later audits (V…, H…). The ones that carry weight:

| Label | Meaning | Where |
|---|---|---|
| W1 | Level by consequence; foreign content marked technically | D14, D32 |
| W2 | Style rules as a testable list; a fixed first message | `src/agent/style.ts`, eval checks |
| W3 | Narrow data scope per tool call | D31, D37, D63 |
| W4 | Approvals with scope and a stated way back | D14 |
| W5 | `cancel_silently` for false alarms | D19 |
| W6 | Memory viewable on request (`show_memory`) | D13 |
| W7 | Real hard delete | D13, D63 |
| W8 | Memory regression test against forgetting corrections | D13 |
| W9 | Actively check the audit log (weekly self-test) | D17 |
| W11 | Own health and incident tracking, external deadman | D10, D44 |
| W12 | Be quiet early | D19, D26 |
| W13 | Disconnect really deletes | D30, D51 |
| W14 | Find changes to known commitments in mail | D33 |
| W15 | Few integrations, done deeply | D31 |
| W16 | Credential surrogation | D30, D36 |
| W17 | One-time codes as their own protection level | D31 |
| W18 | Payments only with a one-time virtual card (not built) | D36, D63 |
| W19–W21 | Situational humour, stated defaults instead of questions, mirror register | style block |
| W22 | Acknowledge only after the precondition check | D16 |
| W23 | Deduplicate identical outbound messages | D11 |
| W24 | 👎 is a correction; the retry must add something new | D24 |
| W28 | Watchers without a model | D43 |
| W31 | Typed `judge` decisions in the mail trigger | D33 |
| V1–V8 | Audit points: living user model (V1), fact kinds (V2), history search (V3), proactive occasions (V4), lessons (V5), unknown-recipient warning (V6), stable system prompt (V7), answer first (V8) | D34, D39–D42, D46, D47 |
| H1–H7 | Nightly consolidation (H1), watchers (H2), morning briefing (H3), memory eval (H4), procedures (H5), missions (H6), owner's base text beats any automatic profile (H7) | D40, D42, D43, D45, D46, D63 |
