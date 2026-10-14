import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { enableBankingDriver, retryAfterMs, signJwt, splitTransactions, toTransaction } = await import("../src/connectors/drivers/enable-banking.js");
const { createPrivateKey } = await import("node:crypto");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CONFIG = { aspsp: { name: "Musterbank", country: "DE" }, appId: "00000000-0000-4000-8000-000000000000", privateKey: PEM };

/** Enable Banking for testing: counts requests, checks the JWT on every request. */
function fakeApi(options: { banks?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Set: the bank refuses every account request, with this `Retry-After` (empty: without). */
  const limit: { retryAfter?: string | null } = {};
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const [header, payload, signature] = auth.replace("Bearer ", "").split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (!verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))) return new Response("{}", { status: 401 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/aspsps") return json({ aspsps: options.banks ?? [{ name: "Musterbank", country: "DE", maximum_consent_validity: 180 * 86_400 }] });
    if (url.pathname === "/auth") return json({ url: "https://tilisy.enablebanking.com/welcome?x=1", authorization_id: "a1" });
    if (url.pathname === "/sessions") return json({ session_id: "s1", accounts: [{ uid: "acc-1", account_id: { iban: "DE02120300000000202051" }, name: "Girokonto", currency: "EUR" }], access: { valid_until: "2027-03-31T10:00:00Z" } });
    if (url.pathname.startsWith("/accounts/") && limit.retryAfter !== undefined) {
      return new Response(JSON.stringify({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }), { status: 429, headers: limit.retryAfter ? { "retry-after": limit.retryAfter } : {} });
    }
    if (url.pathname === "/accounts/acc-1/balances") return json({ balances: [{ name: "Verfügbar", balance_amount: { amount: "1234.56", currency: "EUR" }, balance_type: "ITAV" }] });
    if (url.pathname === "/accounts/acc-1/transactions") {
      if (!url.searchParams.get("continuation_key")) {
        return json({
          continuation_key: "p2",
          transactions: [
            { booking_date: "2026-10-02", transaction_amount: { amount: "12.99", currency: "EUR" }, credit_debit_indicator: "DBIT", creditor: { name: "Netflix" }, remittance_information: ["Abo Oktober"], status: "BOOK" },
            { booking_date: "2026-10-01", transaction_amount: { amount: "2500.00", currency: "EUR" }, credit_debit_indicator: "CRDT", debtor: { name: "Beispiel GmbH" }, remittance_information: ["Gehalt"], status: "BOOK" },
          ],
        });
      }
      return json({ transactions: [{ transaction_amount: { amount: "4.20", currency: "EUR" }, credit_debit_indicator: "DBIT", creditor: { name: "Bäckerei" }, status: "PDNG", bank_transaction_code: { code: "CCRD", sub_code: "POSD" } }] });
    }
    if (url.pathname === "/sessions/s1" && init?.method === "DELETE") return json({});
    return new Response("{}", { status: 404 });
  };
  return { calls, fetcher, limit };
}

async function connected(now: { value: Date }) {
  const api = fakeApi();
  const driver = enableBankingDriver(CONFIG, { id: "bank", fetch: api.fetcher, now: () => now.value });
  const { credentials } = await driver.complete({ pending: {}, code: "code-1", redirectUri: "https://serain.example.com/connections/callback" });
  const live = driver.open({ get: () => credentials, save: async () => undefined });
  const tool = (name: string) => live.tools.find((def) => def.name === name)!;
  return { api, driver, live, tool };
}

const turn = {} as never;

describe("bank through Enable Banking (D51)", () => {
  it("signs every request itself, with the app ID as kid", () => {
    const token = signJwt(CONFIG.appId, createPrivateKey(PEM), Date.UTC(2026, 9, 3));
    const [header, payload] = token.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>);
    expect(header).toEqual({ typ: "JWT", alg: "RS256", kid: CONFIG.appId });
    expect(payload).toMatchObject({ iss: "enablebanking.com", aud: "api.enablebanking.com" });
    expect(Number(payload!["exp"]) - Number(payload!["iat"])).toBeLessThanOrEqual(86_400);
  });

  it("only starts when Enable Banking knows the bank, and asks for at most 180 days", async () => {
    const now = new Date("2026-10-03T10:00:00Z");
    const missing = enableBankingDriver(CONFIG, { id: "bank", fetch: fakeApi({ banks: [{ name: "DKB", country: "DE" }] }).fetcher, now: () => now });
    await expect(missing.begin({ redirectUri: "https://serain.example.com/connections/callback", state: "s" })).rejects.toThrow(/not offered/);
    const api = fakeApi();
    const driver = enableBankingDriver(CONFIG, { id: "bank", fetch: api.fetcher, now: () => now });
    const { authorizeUrl } = await driver.begin({ redirectUri: "https://serain.example.com/connections/callback", state: "st" });
    expect(authorizeUrl).toMatch(/^https:\/\/tilisy/);
    const auth = api.calls.find((call) => call.path === "/auth")!.body as { access: { valid_until: string }; redirect_url: string; state: string; psu_type: string };
    expect(auth).toMatchObject({ redirect_url: "https://serain.example.com/connections/callback", state: "st", psu_type: "personal" });
    expect(Date.parse(auth.access.valid_until) - now.getTime()).toBeLessThanOrEqual(180 * 86_400_000);
  });

  it("without an app on the server it says what is missing", async () => {
    const driver = enableBankingDriver(null, { id: "bank" });
    await expect(driver.begin({ redirectUri: "x", state: "s" })).rejects.toThrow(/ENABLE_BANKING_APP_ID/);
  });

  it("remembers only the last four digits of the account", async () => {
    const api = fakeApi();
    const driver = enableBankingDriver(CONFIG, { id: "bank", fetch: api.fetcher });
    const result = await driver.complete({ pending: {}, code: "c", redirectUri: "x" });
    expect(result.account).toBe("Girokonto ···2051");
    expect(JSON.stringify(result.credentials)).not.toContain("DE0212");
    expect(result.expiresAt?.toISOString()).toBe("2027-03-31T10:00:00.000Z");
  });

  it("reads balance and transactions, filters and marks pending items", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { tool } = await connected(now);
    const balance = await tool("bank_balance").run({}, turn);
    expect(balance.text).toContain("1234.56 EUR available");
    const out = await tool("bank_transactions").run({ direction: "out" }, turn);
    expect(out.text).toContain("booked 2026-10-02  -12.99 EUR  Netflix: Abo Oktober");
    // Pending items stand on their own, without a date and without claiming they are the newest.
    expect(out.text).toContain("Pending, not booked yet (the bank gives no date, can be days ago):\npending  -4.20 EUR  Bäckerei (card)");
    expect(out.text).toContain("Booked, newest booking first:\nbooked 2026-10-02  -12.99 EUR  Netflix");
    expect(out.text).not.toContain("Gehalt");
    const search = await tool("bank_transactions").run({ query: "beispiel" }, turn);
    expect(search.text).toContain("booked 2026-10-01  2500.00 EUR  Beispiel GmbH: Gehalt");
    const past = await tool("bank_transactions").run({ to: "2026-10-02" }, turn);
    expect(past.text).not.toContain("Bäckerei");
    expect(search.text).toContain("1 match\n");
  });

  it("offers transactions as a source for analyze_data, within the period and with pending items up to today (D63)", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { live, api } = await connected(now);
    const [bank] = live.datasets ?? [];
    expect(bank?.name).toBe("bank");
    const all = await bank!.load({ from: new Date("2026-09-30T22:00:00Z"), to: new Date("2026-10-03T22:00:00Z") });
    expect(all.rows).toEqual([
      { date: "2026-10-02", pending: false, amount: -12.99, currency: "EUR", counterparty: "Netflix", text: "Abo Oktober", card: false },
      { date: "2026-10-01", pending: false, amount: 2500, currency: "EUR", counterparty: "Beispiel GmbH", text: "Gehalt", card: false },
      { date: "", pending: true, amount: -4.2, currency: "EUR", counterparty: "Bäckerei", text: "", card: true },
    ]);
    // Up to 1 October: only the incoming payment; pending items do not belong in a period that ends before today.
    const first = await bank!.load({ from: new Date("2026-09-30T22:00:00Z"), to: new Date("2026-10-01T22:00:00Z") });
    expect(first.rows.map((row) => row["counterparty"])).toEqual(["Beispiel GmbH"]);
    // The same state as the tools: no second request.
    const reads = api.calls.length;
    await bank!.load({ from: new Date("2026-09-30T22:00:00Z"), to: new Date("2026-10-03T22:00:00Z") });
    expect(api.calls.length).toBe(reads);
    now.value = new Date("2027-04-01T10:00:00Z");
    await expect(bank!.load({ from: new Date("2027-03-01T00:00:00Z"), to: new Date("2027-04-01T00:00:00Z") })).rejects.toThrow(/expired/);
  });

  it("reads anew as soon as the state is older than 15 minutes", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { api, tool } = await connected(now);
    const fetches = () => api.calls.filter((call) => call.path.endsWith("/balances")).length;
    await tool("bank_balance").run({}, turn);
    now.value = new Date("2026-10-03T10:14:00Z");
    await tool("bank_transactions").run({}, turn);
    expect(fetches()).toBe(1);
    now.value = new Date("2026-10-03T10:16:00Z");
    const fresh = await tool("bank_balance").run({}, turn);
    expect(fetches()).toBe(2);
    expect(fresh.text).toMatch(/^As of Sat 3 Oct, 12:16\n/);
  });

  it("when the bank refuses, it waits 6 hours and answers from the last state until then", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { api, tool } = await connected(now);
    const attempts = () => api.calls.filter((call) => call.path.endsWith("/balances")).length;
    await tool("bank_balance").run({}, turn);
    api.limit.retryAfter = null;
    now.value = new Date("2026-10-03T11:00:00Z");
    const stale = await tool("bank_balance").run({}, turn);
    expect(attempts()).toBe(2);
    expect(stale.ok).toBe(true);
    expect(stale.text).toMatch(/^As of Sat 3 Oct, 12:00\. The bank allows no new request until Sat 3 Oct, 19:00\. This is the last state\.\n/);
    expect(stale.text).toContain("1234.56 EUR available");
    // Until then it does not even ask the bank.
    now.value = new Date("2026-10-03T16:59:00Z");
    expect((await tool("bank_transactions").run({}, turn)).text).toContain("until Sat 3 Oct, 19:00");
    expect(attempts()).toBe(2);
    delete api.limit.retryAfter;
    now.value = new Date("2026-10-03T17:00:00Z");
    const again = await tool("bank_balance").run({}, turn);
    expect(attempts()).toBe(3);
    expect(again.text).toMatch(/^As of Sat 3 Oct, 19:00\n/);
  });

  it("without an old state it says until when the bank blocks, and keeps to its Retry-After", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { api, tool } = await connected(now);
    api.limit.retryAfter = "1800";
    const result = await tool("bank_balance").run({}, turn);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("The bank allows no new request until Sat 3 Oct, 12:30. Tell Alex instead of guessing.");
    delete api.limit.retryAfter;
    now.value = new Date("2026-10-03T10:30:00Z");
    expect((await tool("bank_balance").run({}, turn)).ok).toBe(true);
  });

  it("reads Retry-After as seconds or date, at most one day, otherwise 6 hours", () => {
    const at = Date.UTC(2026, 9, 3, 10);
    expect(retryAfterMs("120", at)).toBe(120_000);
    expect(retryAfterMs(new Date(at + 3_600_000).toUTCString(), at)).toBe(3_600_000);
    expect(retryAfterMs("999999", at)).toBe(86_400_000);
    for (const header of [null, "", "0", "-5", "kaputt", new Date(at - 1000).toUTCString()]) expect(retryAfterMs(header, at)).toBe(6 * 3_600_000);
  });

  it("refuses after the authorization expired and revokes on disconnect", async () => {
    const now = { value: new Date("2027-04-01T10:00:00Z") };
    const { api, driver, tool } = await connected(now);
    const result = await tool("bank_balance").run({}, turn);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("expired");
    expect(await driver.revoke({ sessionId: "s1" })).toBe(true);
    expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/sessions/s1")).toBe(true);
  });

  it("takes from a transaction only what Alex needs", () => {
    expect(toTransaction({ value_date: "2026-10-01", transaction_amount: { amount: "1.00", currency: "EUR" }, credit_debit_indicator: "CRDT", debtor: { name: "  A   B " }, remittance_information: "x" })).toEqual({
      date: "2026-10-01",
      amount: 1,
      currency: "EUR",
      counterparty: "A B",
      text: "x",
      pending: false,
      card: false,
      transfer: false,
      ref: "",
    });
    const transfer = { booking_date: "2026-09-21", transaction_amount: { amount: "250.00", currency: "EUR" }, credit_debit_indicator: "DBIT", creditor: { name: "Jemand" } };
    expect(toTransaction({ ...transfer, bank_transaction_code: { code: "IRCT", sub_code: "ESCT" } }).transfer).toBe(true);
    expect(toTransaction({ ...transfer, bank_transaction_code: { code: "RDDT", sub_code: "ESDD" } }).transfer).toBe(false);
  });

  it("orders booked items by day and sequence number, pending items on their own", () => {
    const t = (date: string, ref: string, pending = false) => ({ date, ref, pending, amount: -1, currency: "EUR", counterparty: ref, text: "", card: true, transfer: false });
    const { pending, booked } = splitTransactions([t("2026-10-03", "500000123"), t("", "9100000000000000001", true), t("2026-10-03", "500000456"), t("2026-10-02", "500000999")]);
    expect(booked.map((x) => x.ref)).toEqual(["500000456", "500000123", "500000999"]);
    expect(pending.map((x) => x.ref)).toEqual(["9100000000000000001"]);
  });
});

describe("subscription check: recurring debits detected in code", async () => {
  const { findRecurring, merchantKey } = await import("../src/connectors/drivers/recurring.js");
  const { describeRecurring } = await import("../src/connectors/drivers/enable-banking.js");
  const out = (date: string, amount: number, counterparty: string, text = "") => ({ date, amount: -amount, currency: "EUR", counterparty, text });

  it("detects monthly, quarterly and weekly with the next debit", () => {
    const found = findRecurring(
      [
        out("2026-07-12", 10.99, "Spotify AB", "P2B3C4 Spotify Premium"),
        out("2026-08-12", 10.99, "SPOTIFY AB 4711"),
        out("2026-09-11", 10.99, "Spotify AB", "Spotify Premium"),
        out("2026-07-31", 30, "Fitness First Germany GmbH"),
        out("2026-08-31", 30, "Fitness First Germany GmbH"),
        out("2026-07-15", 45, "Stadtwerke Musterstadt"),
        out("2026-08-14", 52.3, "Stadtwerke Musterstadt"),
        out("2026-09-15", 49.9, "Stadtwerke Musterstadt"),
        out("2026-07-01", 89.7, "HUK-Coburg"),
        out("2026-09-30", 89.7, "HUK-Coburg"),
        ...["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].map((date) => out(date, 4.5, "Zeitungsabo Wochenend")),
      ],
      "2026-10-05",
    );
    const by = Object.fromEntries(found.map((r) => [r.name, r]));
    expect(by["Spotify AB"]).toMatchObject({ cadence: "monthly", count: 3, last: 10.99, lastDate: "2026-09-11", next: "2026-10-11", missed: false });
    expect(by["Spotify AB"]?.text).toBe("Spotify Premium");
    // September has no 31st: the next one comes on the 30th.
    expect(by["Fitness First Germany GmbH"]).toMatchObject({ cadence: "monthly", next: "2026-09-30", missed: false });
    expect(by["Stadtwerke Musterstadt"]).toMatchObject({ cadence: "monthly", min: 45, max: 52.3, last: 49.9 });
    expect(by["HUK-Coburg"]).toMatchObject({ cadence: "quarterly", next: "2026-12-30" });
    expect(by["Zeitungsabo Wochenend"]).toMatchObject({ cadence: "weekly", next: "2026-10-05" });
    // Highest monthly cost first.
    expect(found[0]?.name).toBe("Stadtwerke Musterstadt");
  });

  it("invents nothing: single items, incoming payments, coincidences at the bakery and gaps are no subscription", () => {
    const found = findRecurring(
      [
        out("2026-09-02", 12.99, "Netflix"),
        { date: "2026-08-01", amount: 2500, currency: "EUR", counterparty: "Beispiel GmbH", text: "Gehalt" },
        { date: "2026-09-01", amount: 2500, currency: "EUR", counterparty: "Beispiel GmbH", text: "Gehalt" },
        out("2026-09-05", 3.2, "Bäckerei Huth"),
        out("2026-09-12", 3.2, "Bäckerei Huth"),
        // Two months apart fit no cadence.
        out("2026-07-03", 9.99, "Disney Plus"),
        out("2026-09-03", 9.99, "Disney Plus"),
        // Same merchant, very different amounts: two purchases, no subscription.
        out("2026-08-10", 23.4, "Amazon EU S.a.r.l."),
        out("2026-09-10", 61.15, "Amazon EU S.a.r.l."),
        { date: "2026-08-20", amount: null, currency: "EUR", counterparty: "Kaputt", text: "" },
        { date: "2026-09-20", amount: null, currency: "EUR", counterparty: "Kaputt", text: "" },
      ],
      "2026-10-05",
    );
    expect(found).toEqual([]);
    expect(describeRecurring(found)).toContain("Nothing recurring");
  });

  it("takes only fixed amounts by card and only fixed amounts weekly (live finding 2026-10-05)", () => {
    const card = (date: string, amount: number, counterparty: string) => ({ ...out(date, amount, counterparty), card: true });
    const found = findRecurring(
      [
        // Rides at a similar price, once a month: purchases, no subscription.
        card("2026-08-03", 19.53, "Uber BV"),
        card("2026-09-02", 21.62, "Uber BV"),
        // The supermarket every week for a few euros, not booked by card and still no subscription.
        ...[["2026-08-04", 4.41], ["2026-08-11", 4.63], ["2026-08-18", 4.79], ["2026-08-25", 4.6]].map(([date, amount]) => out(String(date), Number(amount), "Supermarkt Mitte")),
        // A subscription by card costs the same every time.
        card("2026-08-14", 8.99, "Amazon Prime"),
        card("2026-09-14", 8.99, "Amazon Prime"),
      ],
      "2026-10-05",
    );
    expect(found.map((r) => r.name)).toEqual(["Amazon Prime"]);
  });

  it("never counts Alex's own transfers as a subscription", () => {
    const transfer = (date: string, amount: number) => ({ ...out(date, amount, "Eine Person"), transfer: true });
    expect(findRecurring([transfer("2026-08-17", 250), transfer("2026-09-21", 250)], "2026-10-05")).toEqual([]);
    // The same series as a direct debit stays a subscription.
    expect(findRecurring([out("2026-08-17", 250, "Fitnessstudio"), out("2026-09-17", 250, "Fitnessstudio")], "2026-10-05")).toHaveLength(1);
  });

  it("separates subscriptions through an intermediary by amount and reports missed ones", () => {
    const found = findRecurring(
      [
        out("2026-07-05", 9.99, "PayPal Europe S.a.r.l. et Cie S.C.A", "1043/. Spotify, Ihr Einkauf bei Spotify"),
        out("2026-08-05", 9.99, "PayPal Europe S.a.r.l. et Cie S.C.A", "1044/. Spotify, Ihr Einkauf bei Spotify"),
        out("2026-07-20", 17.99, "PayPal Europe S.a.r.l. et Cie S.C.A", "Netflix"),
        out("2026-08-20", 17.99, "PayPal Europe S.a.r.l. et Cie S.C.A", "Netflix"),
        out("2026-09-19", 17.99, "PayPal Europe S.a.r.l. et Cie S.C.A", "Netflix"),
      ],
      "2026-10-05",
    );
    expect(found).toHaveLength(2);
    const spotify = found.find((r) => r.last === 9.99);
    expect(spotify).toMatchObject({ next: "2026-09-05", missed: true });
    const text = describeRecurring(found);
    expect(text).toContain("did not come, maybe cancelled");
    expect(text).toContain("Together about 17.99 EUR per month, without the ones that stopped.");
    expect(text).toContain("You cannot cancel");
    expect(text).not.toMatch(/[–—]/);
  });

  it("keys payees without legal form and numbers", () => {
    expect(merchantKey("SPOTIFY AB 4711", "")).toBe(merchantKey("Spotify AB", "x"));
    expect(merchantKey("Fitness First Germany GmbH", "")).toBe("fitness first");
    expect(merchantKey("", "Rundfunk ARD ZDF Beitragsservice 123")).toBe("rundfunk ard");
    expect(merchantKey("", "4711 0815")).toBe("");
    // Latin accents fold, as before.
    expect(merchantKey("Müller Drogerie", "")).toBe(merchantKey("MULLER DROGERIE", ""));
  });

  it("keys payees in any script instead of dropping them", () => {
    expect(merchantKey("Яндекс Плюс ООО", "")).toBe("яндекс плюс");
    expect(merchantKey("東京ガス", "")).not.toBe("");
    expect(merchantKey("Ελληνικά Ταχυδρομεία", "")).toBe(merchantKey("ΕΛΛΗΝΙΚΑ ΤΑΧΥΔΡΟΜΕΙΑ", ""));
    // Reference numbers in other digit systems are numbers too.
    expect(merchantKey("", "١٢٣٤ ٥٦٧")).toBe("");
    const found = findRecurring(
      [out("2026-08-12", 5.99, "Яндекс Плюс"), out("2026-09-12", 5.99, "ЯНДЕКС ПЛЮС 4711")],
      "2026-10-05",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cadence: "monthly", next: "2026-10-12" });
  });

  it("is a tool of the bank driver and reads from the same state", async () => {
    const now = { value: new Date("2026-10-03T10:00:00Z") };
    const { api, tool } = await connected(now);
    const result = await tool("bank_subscriptions").run({}, turn);
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/^As of /);
    expect(result.text).toContain("Nothing recurring");
    const reads = api.calls.length;
    await tool("bank_transactions").run({}, turn);
    expect(api.calls.length).toBe(reads);
  });
});
