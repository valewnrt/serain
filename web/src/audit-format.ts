import { connectorInfo, connectorToolLabel } from "../../src/connectors/catalog.js";
import { formatSize } from "../../src/files/name.js";

/**
 * One entry from `web_audit` as a line for the owner: what happened, what it
 * referred to, whether it worked. Which entries appear at all is decided by
 * the view in the database (0016_web.sql), not by this file. The web interface
 * speaks English; values (addresses, subjects, names) stay as stored.
 */

export type AuditCategory = "action" | "access" | "memory" | "security" | "system" | "feedback";

export interface AuditRow {
  id: number | string;
  at: string | Date;
  event: string;
  category: AuditCategory;
  detail: Record<string, unknown>;
  fact: string | null;
}

/** One detail under the title, already shortened; `label` is the name in front of it ("Subject") if there is one. */
export interface AuditLine {
  label: string | null;
  text: string;
}

export interface AuditItem {
  id: string;
  at: string;
  category: AuditCategory;
  title: string;
  lines: AuditLine[];
  status: "ok" | "failed" | "pending" | null;
}

const TOOLS: Record<string, string> = {
  mail_send: "Mail sent",
  mail_search: "Mailbox searched",
  mail_read: "Mail read",
  mail_senders: "Senders analysed",
  mail_code: "Code taken from a mail",
  mail_cleanup: "Mailbox cleaned up",
  mail_spam_folder: "Spam folder cleaned up",
  mail_keep_add: "Sender added to the keep list",
  mail_keep_remove: "Sender removed from the keep list",
  calendar_events: "Calendar read",
  calendar_create: "Event created",
  calendar_update: "Event changed",
  calendar_delete: "Event deleted",
  // Until 2026-10-05 the calendar tools had these names (Google only). The audit log keeps the old names.
  gcal_events: "Calendar read",
  gcal_create: "Event created",
  gcal_update: "Event changed",
  gcal_delete: "Event deleted",
  mac_calendar: "Calendar read on the Mac",
  mac_reminders: "Reminders read on the Mac",
  mac_contacts: "Contacts searched",
  search_history: "Chat history searched",
  run_task: "Research started",
  run_site_task: "Signed-in session",
  vault_file: "File taken from the vault",
  set_reminder: "Reminder set",
  schedule_task: "Task scheduled",
  cancel_schedule: "Scheduled item cancelled",
  watch_create: "Watcher created",
  watch_cancel: "Watcher ended",
  forget_fact: "Fact forgotten",
  propose_procedure: "Procedure proposed",
  forget_procedure: "Procedure forgotten",
};

/** Arguments that say the most about what it was about, in this order. */
const KEY_ARGS = ["site", "task", "to", "cc", "subject", "title", "start", "when", "text", "query", "from", "id", "url", "host", "sender", "senders", "action"];

const KEY_LABELS: Record<string, string> = {
  site: "Site",
  task: "Task",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  title: "Title",
  start: "Start",
  when: "When",
  text: "Text",
  query: "Search",
  from: "From",
  url: "URL",
  host: "Host",
  sender: "Sender",
  senders: "Senders",
  action: "Action",
  label: "Name",
  kind: "Kind",
  what: "What",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/**
 * Dates in the English of the interface, day before month and a 24-hour clock
 * ("2 Oct 2026", "9 Oct, 08:00"), readable wherever the owner lives. The
 * browser formats its own dates in its locale (web/client/ui.ts); these lines
 * are built here, in English, so their dates are English too.
 */
const LOCALE = "en-GB";
/** A plain date is the same day in every time zone: read as noon UTC and written in UTC, never shifted. */
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayTimeFmts = new Map<string, Intl.DateTimeFormat>();

/** Date with time in the owner's time zone (`OWNER_TIMEZONE` in wrangler.toml), built once per zone. */
function dayTimeIn(timeZone: string): Intl.DateTimeFormat {
  let fmt = dayTimeFmts.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    dayTimeFmts.set(timeZone, fmt);
  }
  return fmt;
}

type Short = (value: unknown, max?: number) => string;

/** Values as short text; dates the way the owner reads them: "2 Oct 2026" instead of "2026-10-02". */
function shortIn(timeZone: string): Short {
  const dayTimeFmt = dayTimeIn(timeZone);
  const readable = (value: string): string => {
    if (ISO_DATE.test(value)) return dayFmt.format(new Date(`${value}T12:00:00Z`));
    if (ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))) return dayTimeFmt.format(new Date(value));
    return value;
  };
  return (value, max = 140) => {
    const text = Array.isArray(value) ? value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ") : typeof value === "object" && value !== null ? JSON.stringify(value) : readable(String(value));
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
}

const isTime = (value: unknown) => typeof value === "string" && (ISO_DATE.test(value) || ISO_TIME.test(value));
const line = (label: string | null, text: string): AuditLine => ({ label, text });

/**
 * Up to three arguments. Left out: the mail body, switches (true/false) and
 * IDs that are pure randomness; the owner can do nothing with either.
 */
function argLines(args: unknown, short: Short): AuditLine[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  let keys = [...KEY_ARGS.filter((key) => key in record), ...Object.keys(record).filter((key) => !KEY_ARGS.includes(key))];
  // A time span reads front to back: first "from", then "until".
  if (isTime(record["from"]) && isTime(record["to"])) keys = keys.filter((key) => key !== "from").flatMap((key) => (key === "to" ? ["from", "to"] : [key]));
  return keys
    .filter((key) => {
      const value = record[key];
      if (key === "body" || value === undefined || value === null || value === "" || typeof value === "boolean") return false;
      return !(typeof value === "string" && UUID.test(value));
    })
    .slice(0, 3)
    .map((key) => {
      const value = short(record[key]);
      // For time spans ("chat history from … until …") from/to are not sender and recipient.
      const range = isTime(record[key]);
      const label = range && key === "from" ? "From" : range && key === "to" ? "Until" : (KEY_LABELS[key] ?? key);
      return line(label, value);
    });
}

/**
 * What a standing approval covers. Keys are canonical JSON from
 * `src/agent/tools/grants.ts` (`encodeGrant`); the worker cannot import that
 * file (it pulls in the server's configuration), so the few kinds are named
 * here. Older keys were sentences and are shown as stored, like anything this
 * file does not know.
 */
function grantText(key: unknown): string {
  const raw = str(key);
  if (!raw.startsWith("{")) return raw;
  let scope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return raw;
    scope = parsed as Record<string, unknown>;
  } catch {
    return raw;
  }
  const to = typeof scope["to"] === "string" ? scope["to"] : "";
  switch (scope["kind"]) {
    case "mail_to":
      return to ? `Mails to ${to}` : raw;
    case "mail_to_as_serain":
      return to ? `Mails to ${to} from Serain's mailbox` : raw;
    case "confirm_selftest":
      return "Test runs of the confirmation protocol";
    default:
      return raw;
  }
}

const count = (value: unknown, one: string, many: string) => `${str(value)} ${Number(value) === 1 ? one : many}`;
const str = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));
const toolName = (detail: Record<string, unknown>) => TOOLS[str(detail["tool"])] ?? connectorToolLabel(str(detail["tool"])) ?? str(detail["tool"]);
const serviceName = (detail: Record<string, unknown>) => connectorInfo(str(detail["id"]))?.name ?? str(detail["id"]);

/** `timeZone`: the owner's IANA time zone, in which dates appear in the text. */
export function formatAudit(row: AuditRow, timeZone: string): AuditItem {
  const short = shortIn(timeZone);
  const d = row.detail ?? {};
  const base = { id: String(row.id), at: new Date(row.at).toISOString(), category: row.category };
  const item = (title: string, lines: Array<AuditLine | string> = [], status: AuditItem["status"] = null): AuditItem => ({
    ...base,
    title,
    lines: lines.map((entry) => (typeof entry === "string" ? line(null, entry) : entry)).filter((entry) => entry.text !== ""),
    status,
  });

  switch (row.event) {
    case "tool_call": {
      const pending = d["awaiting_approval"] === true;
      const args = (d["args"] as Record<string, unknown> | undefined) ?? {};
      const tool = str(d["tool"]);
      const title =
        tool === "run_site_task"
          ? `Signed-in session at ${str(args["site"])}`
          : tool === "vault_file"
            ? `File from the vault ${args["send_to_owner"] === true ? "sent to you" : "taken"}: ${str(args["name"])}`
            : toolName(d);
      const result = str(d["result"]);
      const lines = tool === "vault_file" ? [] : argLines(d["args"], short);
      if (!pending && d["ok"] === false && result) lines.push(line("Error", short(result)));
      return item(pending ? `${title} (awaiting confirmation)` : title, lines, pending ? "pending" : d["ok"] === false ? "failed" : "ok");
    }
    case "tool_denied":
      return item(`Blocked: ${toolName(d)}`, [line("Reason", str(d["reason"])), line("Trigger", str(d["origin"]))], "failed");
    case "task_finished":
      return item(
        d["site"] ? `Session at ${str(d["site"])} finished` : "Research finished",
        [`${count(d["steps"], "step", "steps")}${Number(d["failures"]) > 0 ? `, ${str(d["failures"])} failed` : ""}`, d["stopped"] && d["stopped"] !== "finish_task" ? `End: ${str(d["stopped"])}` : ""],
        d["ok"] === false ? "failed" : "ok",
      );
    case "task_cancelled":
      return item("Task cancelled", [], "failed");
    // After a crash (D52).
    case "task_interrupted":
      return item(d["site"] ? `Session at ${str(d["site"])} interrupted by a restart` : "Research interrupted by a restart", ["reported, not repeated"], "failed");
    case "turn_recovered":
      return item("Unanswered message caught up", [Number(d["actions"]) > 0 ? `${count(d["actions"], "action was", "actions were")} already done` : ""], "ok");
    case "turn_abandoned":
      return item(d["reason"] ? "Message not caught up" : `${count(d["count"], "message", "messages")} too old to catch up`, [d["reason"] ? str(d["reason"]) : ""], "failed");
    case "schedule_fired": {
      // Deviation from the planned time; older entries capped it at zero, none can be early.
      const late = typeof d["late_ms"] === "number" ? d["late_ms"] : null;
      const early = late !== null && late < 0;
      return item(
        d["mode"] === "task" ? "Scheduled task triggered" : "Reminder triggered",
        [late === null ? "" : early ? `${Math.ceil(-late / 1_000)} s too early` : `${Math.round(late / 1_000)} s after the planned time`],
        early ? "failed" : "ok",
      );
    }
    case "schedule_failed":
      return item("Scheduled item failed", [str(d["reason"])], "failed");
    case "approval_requested":
      return item(`Confirmation requested: ${toolName(d)}`, [...argLines(d["args"], short), d["tainted"] === true ? "after untrusted content" : ""], "pending");
    case "approval_decided":
      return item(`${str(d["status"]) === "approved" ? "Confirmed" : "Declined"}: ${toolName(d)}`, [line("Via", `${str(d["via"])}${d["scope"] && d["scope"] !== "once" ? `, ${str(d["scope"])}` : ""}`)], str(d["status"]) === "approved" ? "ok" : "failed");
    case "approval_denied":
      return item("Confirmation not accepted", [str(d["reason"])], "failed");
    case "approval_expired":
      return item(d["tool"] ? `Confirmation expired: ${toolName(d)}` : `${count(d["count"], "confirmation", "confirmations")} expired`, [], "failed");
    case "approval_grant":
      return item(`Standing approval granted: ${toolName(d)}`, [grantText(d["grant_key"])]);
    case "approval_grant_used":
      return item(`Standing approval used: ${toolName(d)}`, [grantText(d["grant_key"])]);
    case "approval_waived":
      return item(`Without a preview, named by you: ${toolName(d)}`, [line("Evidence", str(d["named_by_owner"])), d["tainted"] === true ? "after untrusted content" : ""], "ok");
    case "approval_interrupted":
      return item(`Confirmed, but interrupted by a restart: ${toolName(d)}`, ["outcome unclear, not repeated"], "failed");
    case "approval_scheduled":
      return item(`Confirmed for later: ${toolName(d)}`, [line("Runs", short(d["execute_at"]))], "pending");
    case "approval_later_refused":
      return item(`Not scheduled: ${toolName(d)}`, [str(d["reason"])], "failed");
    case "approval_cancelled":
      return item(d["tool"] ? `Scheduled item cancelled: ${toolName(d)}` : `${count(d["count"], "scheduled approval", "scheduled approvals")} cancelled`, [line("Via", str(d["via"]))], "failed");
    case "approval_due":
      return item(`Scheduled item triggered: ${toolName(d)}`, [typeof d["late_ms"] === "number" ? `${Math.round(d["late_ms"] / 1_000)} s after the planned time` : ""], "ok");
    case "approval_missed":
      return item(`Scheduled item missed: ${toolName(d)}`, [typeof d["late_ms"] === "number" ? `${Math.round(d["late_ms"] / 60_000)} min too late, not run` : ""], "failed");
    // 👍 on an expired preview (addendum to D8 of 2026-10-10).
    case "approval_reissued":
      return item(`Expired preview issued again: ${toolName(d)}`, [d["tainted"] === true ? "after untrusted content" : "", "runs only after a new 👍"], "pending");
    case "approval_reissue_refused":
      return item(`Expired preview not issued again: ${toolName(d)}`, [str(d["reason"])], "failed");
    case "approval_revoked":
      return item("Standing approvals revoked", [count(d["count"], "approval", "approvals")]);
    case "inbound_rejected":
      return item(d["kind"] === "reaction" ? "Foreign reaction discarded" : "Foreign message discarded", [line("From", str(d["from"])), line("Reason", str(d["reason"]))], "failed");
    case "kill_switch":
      return d["skipped"] === true ? item("Not handled because of the stop", [str(d["kind"])]) : item("Stop triggered", [str(d["reason"])]);
    case "kill_switch_release":
      return item("Stop lifted", [str(d["reason"])]);
    case "integration_connected":
      return item(`Account connected: ${str(d["id"])}`, [d["reconnect"] === true ? "connected again" : ""], "ok");
    case "integration_disconnected":
      return item(`Account disconnected: ${str(d["id"])}`, [d["revoked"] === false ? "revoking at the provider failed" : ""]);
    case "connector_requested":
      return item(`Connection started: ${serviceName(d)}`, [], "pending");
    case "connector_connected":
      return item(`Connected: ${serviceName(d)}`, [Array.isArray(d["missing"]) && d["missing"].length > 0 ? `${count(d["missing"].length, "tool is", "tools are")} not offered by the service right now` : ""], "ok");
    case "connector_failed":
      return item(`Connecting failed: ${serviceName(d)}`, [str(d["reason"]) === "expired" ? "the authorization did not come back" : short(d["reason"])], "failed");
    case "connector_disconnect_requested":
      return item(`Disconnect requested: ${serviceName(d)}`);
    case "connector_disconnected":
      return item(`Disconnected: ${serviceName(d)}`, [d["revoked"] === false ? "revoking at the provider failed" : d["revoked"] === null ? "the provider has no revocation" : "revoked at the provider"], "ok");
    case "vault_saved":
      return item(`Vault: ${str(d["site"])} ${d["replaced"] === true ? "replaced" : "created"}`, [str(d["username"]), short(d["hosts"])], "ok");
    case "vault_deleted":
      return item(`Vault: ${str(d["site"])} deleted`, [], "ok");
    case "vault_file_saved":
      return item(`Vault: file ${str(d["name"])} ${d["replaced"] === true ? "replaced" : "stored"}`, [str(d["filename"]), formatSize(Number(d["size"]))], "ok");
    case "vault_file_deleted":
      return item(`Vault: file ${str(d["name"])} deleted`, [], "ok");
    case "web_login":
      return item(d["reauth"] === true ? "Confirmed in the web interface" : "Signed in to the web interface", [], "ok");
    case "web_logout":
      return item("Signed out of the web interface");
    case "web_login_failed":
      return item("Sign-in to the web interface failed", [str(d["reason"])], "failed");
    case "web_passkey_added":
      return item("Passkey added", [str(d["label"])], "ok");
    case "web_passkey_removed":
      return item("Passkey removed", [str(d["label"])]);
    case "budget_warning":
      // Until 2026-10-08 there was only `api` (70 %); since then throttled (80 %) and exhausted (100 %).
      return item(d["kind"] === "exhausted" ? "API budget used up" : d["kind"] === "throttle" ? "API budget throttled" : "Budget warning", [], "failed");
    case "feedback":
      // Serain's own list (`give_feedback`): what it is missing or what did not work. After untrusted content that is noted.
      return item(d["kind"] === "bug" ? "Feedback: did not work" : "Feedback: missing", [
        short(d["description"], 500),
        d["tainted"] === true ? line("Caution", "noted after untrusted content, may come from there") : "",
      ]);
    case "selftest":
      return item(d["synthetic_error"] === true ? "Audit self-test: probe written" : "Audit self-test", [], "ok");
    case "memory_fact":
      return item(row.fact ? "Remembered" : "Remembered (since replaced or forgotten)", [row.fact ? short(row.fact, 300) : "", str(d["decision"]) === "update" ? "updated" : ""]);
    case "memory_forget":
      return item(d["kind"] === "procedure" ? "Procedure forgotten" : "Forgotten", d["kind"] === "procedure" ? [] : [`${count(d["deleted"], "fact", "facts")}${Number(d["summaries_deleted"]) > 0 ? `, ${count(d["summaries_deleted"], "summary", "summaries")}` : ""}`, short(d["categories"])]);
    case "memory_user_model":
      return item("User model adjusted", [str(d["action"]) === "forget" ? `${count(d["removed_lines"], "line", "lines")} removed` : ""]);
    case "memory_consolidation":
      return item("Memory consolidated overnight", [`${str(d["added"] ?? 0)} new, ${str(d["expired"] ?? 0)} expired`]);
    case "memory_proposal":
      return item(d["action"] === "offered" ? "Lesson proposed for approval" : "Lesson noted", []);
    case "watcher":
      return item(d["action"] === "cancelled" ? "Watcher ended" : d["action"] === "expired" ? "Watcher expired" : "Watcher failed", [str(d["reason"])], d["action"] === "failed" ? "failed" : null);
    case "error":
      return item("Error", [str(d["stage"]), short(d["reason"])], "failed");
    case "outbound_failed":
      return item("Message not delivered", [short(d["reason"])], "failed");
    case "channel_disconnected":
      return item("iMessage connection lost", [short(d["reason"])], "failed");
    case "delivery_health":
      return item(d["healthy"] === false ? "Delivery disrupted" : "Delivery back to normal", [`${str(d["failures"])} of ${str(d["attempts"])} failed`], d["healthy"] === false ? "failed" : "ok");
    case "mail_trigger":
      return item("Mail check failed", [short(d["detail"])], "failed");
    default:
      return item(row.event, argLines(d, short));
  }
}
