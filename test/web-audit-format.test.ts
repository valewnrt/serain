import { describe, expect, it } from "vitest";
import { connectorToolLabel } from "../src/connectors/catalog.js";
import { formatSize } from "../src/files/name.js";
import { formatAudit, type AuditRow } from "../web/src/audit-format.js";

/** The owner's time zone in these tests (OWNER_TIMEZONE in vitest.config.ts). */
const TZ = "Europe/Berlin";
const format = (entry: AuditRow) => formatAudit(entry, TZ);

const row = (event: string, detail: Record<string, unknown>, extra: Partial<AuditRow> = {}): AuditRow => ({
  id: 1,
  at: "2026-10-02T08:00:00Z",
  event,
  category: "action",
  detail,
  fact: null,
  ...extra,
});

describe("audit in the web interface: readable lines (D49)", () => {
  it("names the action, the most important arguments and whether it worked", () => {
    const item = format(row("tool_call", { tool: "mail_send", level: "irreversible", ok: true, args: { to: ["anna@example.org"], subject: "Termin", body: "langer Text" } }));
    expect(item).toMatchObject({ title: "Mail sent", status: "ok", at: "2026-10-02T08:00:00.000Z" });
    expect(item.lines).toEqual([
      { label: "To", text: "anna@example.org" },
      { label: "Subject", text: "Termin" },
    ]);
  });

  it("shows scheduled approvals with time, cancellation and missed ones (addendum to D14 of 2026-10-08)", () => {
    expect(format(row("approval_scheduled", { tool: "mail_send", execute_at: "2026-10-09T06:00:00Z" }))).toMatchObject({
      title: "Confirmed for later: Mail sent",
      status: "pending",
      lines: [{ label: "Runs", text: "9 Oct, 08:00" }],
    });
    expect(format(row("approval_cancelled", { via: "kill_switch", count: 2 })).title).toBe("2 scheduled approvals cancelled");
    expect(format(row("approval_missed", { tool: "mail_send", late_ms: 45 * 60_000 }))).toMatchObject({ status: "failed", lines: [{ label: null, text: "45 min too late, not run" }] });
  });

  it("writes times in the owner's time zone", () => {
    const at = "2026-10-09T06:00:00Z";
    expect(formatAudit(row("approval_scheduled", { tool: "mail_send", execute_at: at }), "America/New_York").lines).toEqual([{ label: "Runs", text: "9 Oct, 02:00" }]);
  });

  it("shows an expired preview that was issued again or not (addendum to D8 of 2026-10-10)", () => {
    expect(format(row("approval_reissued", { tool: "calendar_offer", tainted: true }))).toMatchObject({ status: "pending" });
    expect(format(row("approval_reissued", { tool: "calendar_offer" })).title).toContain("Expired preview issued again");
    expect(format(row("approval_reissue_refused", { tool: "mail_send", reason: "stale" }))).toMatchObject({ status: "failed", lines: [{ label: null, text: "stale" }] });
  });

  it("shows what a standing approval covers, structured keys in words and old keys as stored", () => {
    expect(format(row("approval_grant", { tool: "mail_send", grant_key: '{"kind":"mail_to","to":"anna@example.org"}' }))).toMatchObject({
      title: "Standing approval granted: Mail sent",
      lines: [{ label: null, text: "Mails to anna@example.org" }],
    });
    expect(format(row("approval_grant_used", { tool: "mail_send", grant_key: '{"kind":"mail_to_as_serain","to":"bob@example.org"}' })).lines).toEqual([
      { label: null, text: "Mails to bob@example.org from Serain's mailbox" },
    ]);
    expect(format(row("approval_grant", { tool: "confirm_selftest", grant_key: '{"kind":"confirm_selftest"}' })).lines[0]?.text).toBe("Test runs of the confirmation protocol");
    // Keys from before the structured form, unknown kinds and broken JSON stay verbatim.
    expect(format(row("approval_grant_used", { tool: "mail_send", grant_key: "Mails an anna@example.org" })).lines[0]?.text).toBe("Mails an anna@example.org");
    expect(format(row("approval_grant_used", { tool: "x", grant_key: '{"kind":"pay_to","to":"x"}' })).lines[0]?.text).toBe('{"kind":"pay_to","to":"x"}');
    expect(format(row("approval_grant_used", { tool: "x", grant_key: '{"kind":"mail_to"' })).lines[0]?.text).toBe('{"kind":"mail_to"');
    expect(format(row("approval_grant_used", { tool: "x", grant_key: '{"kind":"mail_to"}' })).lines[0]?.text).toBe('{"kind":"mail_to"}');
  });

  it("names vault files by name, says whether Serain sent them to Alex, never the result", () => {
    expect(format(row("tool_call", { tool: "vault_file", ok: true, args: { name: "ausweis", send_to_owner: true }, result: "ID 0123" }))).toMatchObject({
      title: "File from the vault sent to you: ausweis",
      lines: [],
    });
    expect(format(row("tool_call", { tool: "vault_file", ok: true, args: { name: "ausweis", send_to_owner: false } })).title).toBe("File from the vault taken: ausweis");
    expect(format(row("vault_file_saved", { name: "ausweis", filename: "Ausweis.pdf", size: 1_258_291, replaced: false }))).toMatchObject({
      title: "Vault: file ausweis stored",
      lines: [{ label: null, text: "Ausweis.pdf" }, { label: null, text: formatSize(1_258_291) }],
    });
    expect(format(row("vault_file_deleted", { name: "ausweis" })).title).toBe("Vault: file ausweis deleted");
  });

  it("shows Serain's feedback with kind and description, and warns after untrusted content", () => {
    expect(format(row("feedback", { kind: "feature", description: "Kann keine PDF-Formulare ausfüllen.", tainted: false }, { category: "feedback" }))).toMatchObject({
      title: "Feedback: missing",
      category: "feedback",
      lines: [{ label: null, text: "Kann keine PDF-Formulare ausfüllen." }],
    });
    expect(format(row("feedback", { kind: "bug", description: "mail_search fand nichts, obwohl die Mail da war.", tainted: true }, { category: "feedback" }))).toMatchObject({
      title: "Feedback: did not work",
      lines: [
        { label: null, text: "mail_search fand nichts, obwohl die Mail da war." },
        { label: "Caution", text: "noted after untrusted content, may come from there" },
      ],
    });
  });

  it("shows what awaits Alex's confirmation, and what failed, with the reason", () => {
    expect(format(row("tool_call", { tool: "gcal_delete", ok: true, awaiting_approval: true, args: { id: "x" } }))).toMatchObject({ title: "Event deleted (awaiting confirmation)", status: "pending" });
    const failed = format(row("tool_call", { tool: "mail_search", ok: false, args: { from: "bahn" }, result: "IMAP not reachable" }));
    expect(failed.status).toBe("failed");
    expect(failed.lines).toContainEqual({ label: "Error", text: "IMAP not reachable" });
  });

  it("names the site of a signed-in session", () => {
    expect(format(row("tool_call", { tool: "run_site_task", ok: true, args: { site: "bahn", task: "Nächste Fahrt" } })).title).toBe("Signed-in session at bahn");
  });

  it("shows remembered facts with content and says when they are gone since", () => {
    expect(format(row("memory_fact", { decision: "new" }, { fact: "Alex trinkt keinen Kaffee." })).lines).toEqual([{ label: null, text: "Alex trinkt keinen Kaffee." }]);
    expect(format(row("memory_fact", { decision: "new" })).title).toContain("since replaced or forgotten");
  });

  it("counts in singular and plural", () => {
    expect(format(row("turn_recovered", { actions: 1 })).lines).toEqual([{ label: null, text: "1 action was already done" }]);
    expect(format(row("turn_recovered", { actions: 2 })).lines).toEqual([{ label: null, text: "2 actions were already done" }]);
    expect(format(row("approval_revoked", { count: 1 })).lines).toEqual([{ label: null, text: "1 approval" }]);
    expect(format(row("memory_forget", { deleted: 2, summaries_deleted: 1, categories: ["stadt"] })).lines[0]?.text).toBe("2 facts, 1 summary");
  });

  it("shortens long values and handles unknown events too", () => {
    const long = format(row("tool_call", { tool: "run_task", ok: true, args: { task: "x".repeat(400) } }));
    expect(long.lines[0]!.text.length).toBeLessThanOrEqual(140);
    expect(format(row("new_event", { a: 1 })).title).toBe("new_event");
  });

  it("leaves out random IDs and switches and writes dates readably", () => {
    const item = format(row("tool_call", { tool: "search_history", ok: true, args: { query: "S-Bahn", from: "2026-10-02", to: "2026-10-03", id: "845329ac-a398-45cb-a16e-5ea3f695fdb2", all_lines: true } }));
    expect(item.lines).toEqual([
      { label: "From", text: "2 Oct 2026" },
      { label: "Until", text: "3 Oct 2026" },
      { label: "Search", text: "S-Bahn" },
    ]);
  });

  it("describes security events", () => {
    expect(format(row("inbound_rejected", { from: "+4900", reason: "not_owner" })).title).toBe("Foreign message discarded");
    expect(format(row("vault_saved", { site: "bahn", replaced: true, username: "v", hosts: ["bahn.de"] })).title).toBe("Vault: bahn replaced");
    expect(format(row("web_login", { reauth: true })).title).toBe("Confirmed in the web interface");
    expect(format(row("approval_decided", { tool: "mail_send", status: "approved", via: "reaction", scope: "once" }))).toMatchObject({ title: "Confirmed: Mail sent", lines: [{ label: "Via", text: "reaction" }] });
  });
});

describe("audit in the web interface: connections (D51)", () => {
  it("names services and their tools with the catalog's labels", () => {
    expect(format(row("tool_call", { tool: "coros_sleep", level: "read", ok: true, args: { date: "2026-10-01" } })).title).toBe(connectorToolLabel("coros_sleep"));
    expect(connectorToolLabel("coros_sleep")).toMatch(/^COROS: /);
    expect(format(row("connector_connected", { id: "coros", tools: [], missing: ["coros_stress"] }))).toMatchObject({
      title: "Connected: COROS",
      status: "ok",
      lines: [{ label: null, text: "1 tool is not offered by the service right now" }],
    });
    expect(format(row("connector_failed", { id: "bank", reason: "expired" })).lines).toEqual([{ label: null, text: "the authorization did not come back" }]);
    expect(format(row("connector_disconnected", { id: "coros", revoked: null })).lines[0]?.text).toBe("the provider has no revocation");
  });
});
