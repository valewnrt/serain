import { bookingKind, type BookingEvent } from "../mail/findings.js";
import { EMPTY_TRIGGER_STATE, type MailItem, type MailItemStore, type MailTriggerState, type PendingItem } from "../mail/trigger.js";
import type { MailItemReader } from "../mail/open-items.js";
import type { SenderTrust } from "../mail/sender-auth.js";
import { db } from "./client.js";
import { columns, pgRows, pgRun } from "./pg.js";

/** `mail_items` and the mail trigger's state against Supabase (D33). */
const STATE_KEY = "mail_trigger";
const COLUMNS = "id, integration_id, external_id, thread_key, sender, subject, received_at, category, summary, commitment, changes_item, sender_trust";

type Commitment = MailItem["commitment"];

function bookingEvent(value: unknown): BookingEvent | undefined {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw["title"] !== "string" || typeof raw["start"] !== "string") return undefined;
  const kind = bookingKind(raw["kind"]);
  return {
    title: raw["title"],
    start: raw["start"],
    end: typeof raw["end"] === "string" ? raw["end"] : null,
    place: typeof raw["place"] === "string" ? raw["place"] : "",
    // Without the kind, the sentence above the preview only says "your booking" (addendum D62 of 2026-10-10).
    ...(kind ? { kind } : {}),
  };
}

/** Entries from before V4 have no `due`: they stay known items but never count as a deadline. */
export function commitment(value: unknown): Commitment {
  const raw = value as { what?: unknown; when?: unknown; due?: unknown; event?: unknown } | null;
  if (!raw || typeof raw.what !== "string") return null;
  const event = bookingEvent(raw.event);
  return { what: raw.what, when: typeof raw.when === "string" ? raw.when : "", due: typeof raw.due === "string" ? raw.due : null, ...(event ? { event } : {}) };
}

type Row = Record<string, unknown>;

/** Entries from before 0031 have no check. */
function senderTrust(value: unknown): SenderTrust | null {
  return value === "known" || value === "new" || value === "unverified" ? value : null;
}

/** Rows as entries, each change with the commitment it changes. */
async function withPrevious(rows: readonly Row[]): Promise<PendingItem[]> {
  const changed = rows.flatMap((row) => (row["changes_item"] ? [String(row["changes_item"])] : []));
  const previous = new Map<string, Commitment>();
  if (changed.length > 0) {
    const { data: earlier, error: earlierError } = await db.from("mail_items").select("id, commitment").in("id", changed);
    if (earlierError) throw new Error(`Earlier commitments not readable: ${earlierError.message}`);
    for (const row of earlier ?? []) previous.set(String(row.id), commitment(row.commitment));
  }
  return rows.map(
    (row): PendingItem => ({
      id: String(row["id"]),
      integrationId: String(row["integration_id"]),
      externalId: String(row["external_id"]),
      threadKey: String(row["thread_key"] ?? ""),
      sender: String(row["sender"] ?? ""),
      subject: String(row["subject"] ?? ""),
      receivedAt: row["received_at"] as string,
      category: row["category"] as PendingItem["category"],
      summary: String(row["summary"] ?? ""),
      commitment: commitment(row["commitment"]),
      changesItem: row["changes_item"] ? String(row["changes_item"]) : null,
      senderTrust: senderTrust(row["sender_trust"]),
      previous: row["changes_item"] ? (previous.get(String(row["changes_item"])) ?? null) : null,
    }),
  );
}

export const mailItemStore: MailItemStore & MailItemReader = {
  async known(since, limit) {
    const { data, error } = await db
      .from("mail_items")
      .select("id, sender, commitment")
      .not("commitment", "is", null)
      .gt("received_at", since.toISOString())
      .order("received_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Known commitments not readable: ${error.message}`);
    return (data ?? []).flatMap((row) => {
      const value = commitment(row.commitment);
      return value ? [{ key: `item:${String(row.id)}`, what: value.what, when: value.when, from: String(row.sender ?? "") }] : [];
    });
  },

  async insert(item) {
    const { error } = await db.from("mail_items").insert({
      integration_id: item.integrationId,
      external_id: item.externalId,
      thread_key: item.threadKey,
      sender: item.sender,
      subject: item.subject,
      received_at: item.receivedAt,
      category: item.category,
      summary: item.summary,
      commitment: item.commitment,
      changes_item: item.changesItem,
      sender_trust: item.senderTrust ?? null,
      ...(item.quiet ? { notified_at: new Date().toISOString() } : {}),
    });
    if (error?.code === "23505") return false;
    if (error) throw new Error(`Mail item not saved: ${error.message}`);
    return true;
  },

  async pending(limit) {
    // After every mail run, hence via Postgres (`pg.ts`).
    const data = await pgRows<Row>(
      "Pending mail items not readable",
      (sql) => sql`
        select ${columns(sql, COLUMNS)} from public.mail_items
        where notified_at is null and category <> 'none'
        order by created_at asc limit ${limit}`,
    );
    return withPrevious(data);
  },

  async recent(since, limit) {
    const { data, error } = await db
      .from("mail_items")
      .select(COLUMNS)
      .neq("category", "none")
      .gt("received_at", since.toISOString())
      .order("received_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Mail items not readable: ${error.message}`);
    return withPrevious(data ?? []);
  },

  async markNotified(ids, at) {
    if (ids.length === 0) return;
    const { error } = await db.from("mail_items").update({ notified_at: at.toISOString() }).in("id", ids);
    if (error) throw new Error(`Mail items not marked as notified: ${error.message}`);
  },
};

export const mailTriggerState = {
  async load(): Promise<MailTriggerState> {
    // On the mail trigger's tick, hence via Postgres (`pg.ts`).
    const rows = await pgRows<{ value: unknown }>(
      "Mail trigger state not readable",
      (sql) => sql`select value from public.agent_state where key = ${STATE_KEY}`,
    );
    const value = (rows[0]?.value ?? {}) as Partial<MailTriggerState>;
    return {
      lastPolledAt: typeof value.lastPolledAt === "string" ? value.lastPolledAt : null,
      lastNotifiedAt: typeof value.lastNotifiedAt === "string" ? value.lastNotifiedAt : null,
      notifyDay: typeof value.notifyDay === "string" ? value.notifyDay : null,
      notifyCount: typeof value.notifyCount === "number" ? value.notifyCount : EMPTY_TRIGGER_STATE.notifyCount,
    };
  },

  async save(state: MailTriggerState): Promise<void> {
    await pgRun(
      "Mail trigger state not saved",
      (sql) => sql`
        insert into public.agent_state (key, value, updated_at) values (${STATE_KEY}, ${sql.json(state as never)}, now())
        on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    );
  },
};
