import { addDays, daysBetween, parseDay } from "../../time.js";

/**
 * Subscriptions and contracts from account transactions (subscription check,
 * audit 2026-10-05). Purely deterministic, without a model: same payee,
 * similar amount, fixed cadence. A model reading 90 days of transactions would
 * guess and add up amounts that do not belong together; here every number
 * stands as the bank booked it.
 *
 * Only what is already booked is read: pending items have no date at some
 * banks (D51), and without a date there is no cadence. Cancelling stays with
 * the owner.
 */

export interface Booking {
  /** Booking day YYYY-MM-DD. */
  date: string;
  /** Negative: debit. Null: unreadable, does not count. */
  amount: number | null;
  currency: string;
  counterparty: string;
  text: string;
  /** Card payment. Varying amounts only count for direct debits, see `findRecurring`. */
  card?: boolean;
  /** The owner's transfer or standing order: never counts, see `findRecurring`. */
  transfer?: boolean;
}

export type Cadence = "weekly" | "monthly" | "quarterly";

export interface Recurring {
  /** Payee, as the bank named it the last time. */
  name: string;
  /** Payment reference of the last debit, shortened. Untrusted content. */
  text: string;
  cadence: Cadence;
  currency: string;
  /** Amount of the last debit, positive. */
  last: number;
  min: number;
  max: number;
  count: number;
  first: string;
  lastDate: string;
  /** When the next one is roughly due. */
  next: string;
  /** The expected debit is clearly overdue: maybe cancelled. */
  missed: boolean;
  /** Converted to one month, for the sum. */
  perMonth: number;
}

/**
 * Words that distinguish no merchant: legal forms and filler words in payee
 * names. A list of the names banks print (mostly German and English legal
 * forms), not of Serain's own texts; in other languages a filler word only
 * makes a key longer, never merges two merchants.
 */
const NOISE = new Set([
  "gmbh", "mbh", "ag", "se", "kg", "ug", "co", "ohg", "ev", "e", "v", "inc", "ltd", "limited", "llc", "bv", "nv", "sa", "sas",
  "sarl", "s", "a", "r", "l", "et", "cie", "sca", "plc", "de", "deutschland", "germany", "europe", "eu", "the", "und", "and",
]);

/** Payment services with many merchants behind them: there only the payment reference says who it is. */
const INTERMEDIARIES = new Set(["paypal", "klarna", "stripe", "adyen", "mollie", "unzer"]);

/**
 * Words of a name in any script: Latin accents are folded ("Müller" and
 * "Muller" are one), letters, combining marks and digits of every other
 * script stay, so "Яндекс" or "東京ガス" keep a key instead of vanishing.
 * Words with a digit are reference numbers, in any script.
 */
const keyWords = (source: string) =>
  source
    .toLocaleLowerCase("de")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => [...word].length >= 2 && !/\p{N}/u.test(word) && !NOISE.has(word))
    .slice(0, 2)
    .join(" ");

/**
 * Key for "the same payee": the first two words of the name without legal
 * form, digits and punctuation. "Spotify AB" and "SPOTIFY AB 12345" are the
 * same; without a name the payment reference counts, with PayPal and co.
 * both.
 */
export function merchantKey(counterparty: string, text: string): string {
  const name = keyWords(counterparty);
  if (!name) return keyWords(text);
  return INTERMEDIARIES.has(name.split(" ")[0]!) ? `${name}|${keyWords(text)}` : name;
}

const RANGES: Record<Cadence, { min: number; max: number; count: number; perMonth: number }> = {
  // Weekly only from four times: the same amount twice at the bakery is no subscription.
  weekly: { min: 6, max: 8, count: 4, perMonth: 52 / 12 },
  monthly: { min: 26, max: 35, count: 2, perMonth: 1 },
  quarterly: { min: 84, max: 97, count: 2, perMonth: 1 / 3 },
};

/**
 * Same amount with some slack: electricity and phone vary, but at most by 12 %
 * of the group's mean (at least 50 cents). If two subscriptions with the same
 * payee are that close, they merge and their cadence no longer fits: then both
 * are missing, none is invented.
 */
function cluster(bookings: readonly Booking[]): Booking[][] {
  const groups: Booking[][] = [];
  const mean = (group: readonly Booking[]) => group.reduce((sum, entry) => sum + Math.abs(entry.amount!), 0) / group.length;
  for (const booking of [...bookings].sort((a, b) => Math.abs(a.amount!) - Math.abs(b.amount!))) {
    const amount = Math.abs(booking.amount!);
    const group = groups.find((entry) => {
      const center = mean(entry);
      return entry[0]!.currency === booking.currency && Math.abs(amount - center) <= Math.max(0.5, 0.12 * center);
    });
    if (group) group.push(booking);
    else groups.push([booking]);
  }
  return groups;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The same day `months` months later; the 31st does not always exist, then the last day. */
function addMonths(day: string, months: number): string {
  const parsed = parseDay(day)!;
  const target = new Date(Date.UTC(parsed.year, parsed.month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(parsed.day, last));
  return target.toISOString().slice(0, 10);
}

/**
 * Recurring debits in `bookings`, highest monthly cost first. Per payee and
 * amount group every gap has to fit the cadence; a skipped debit breaks the
 * series, better one too few than an invented subscription.
 */
export function findRecurring(bookings: readonly Booking[], today: string): Recurring[] {
  const byMerchant = new Map<string, Booking[]>();
  for (const booking of bookings) {
    if (booking.amount === null || booking.amount >= 0 || !parseDay(booking.date)) continue;
    // A subscription is collected by the provider, by direct debit or card. What the owner transfers
    // themselves (money to family, rent by standing order) is none, even if it was the same twice.
    if (booking.transfer === true) continue;
    const key = merchantKey(booking.counterparty, booking.text);
    if (!key) continue;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), booking]);
  }
  const found: Recurring[] = [];
  for (const group of byMerchant.values()) {
    for (const members of cluster(group)) {
      const dated = [...members].sort((a, b) => a.date.localeCompare(b.date));
      const days = [...new Set(dated.map((booking) => booking.date))];
      if (days.length < 2) continue;
      const gaps = days.slice(1).map((day, index) => daysBetween(days[index]!, day));
      const cadence = (Object.keys(RANGES) as Cadence[]).find((name) => {
        const range = RANGES[name];
        return days.length >= range.count && gaps.every((gap) => gap >= range.min && gap <= range.max);
      });
      if (!cadence) continue;
      // A subscription by card costs the same every time; what varies and goes by card is shopping
      // (live on 2026-10-05: rides and the supermarket). Direct debits like electricity may vary.
      // Weekly only with a fixed amount: four similar purchases in four weeks are a habit.
      const spread = Math.max(...dated.map((b) => Math.abs(b.amount!))) - Math.min(...dated.map((b) => Math.abs(b.amount!)));
      const varies = spread > 0.02 * Math.abs(dated[0]!.amount!) + 0.005;
      if (varies && (cadence === "weekly" || dated.some((booking) => booking.card === true))) continue;
      const last = dated[dated.length - 1]!;
      const lastDate = days[days.length - 1]!;
      const next = cadence === "monthly" ? addMonths(lastDate, 1) : cadence === "quarterly" ? addMonths(lastDate, 3) : addDays(lastDate, Math.round(median(gaps)));
      const amounts = dated.map((booking) => Math.abs(booking.amount!));
      found.push({
        name: last.counterparty || last.text.slice(0, 40) || "(no name)",
        text: last.counterparty ? last.text.slice(0, 60) : "",
        cadence,
        currency: last.currency,
        last: Math.abs(last.amount!),
        min: Math.min(...amounts),
        max: Math.max(...amounts),
        count: days.length,
        first: days[0]!,
        lastDate,
        next,
        // One week of slack: booking days shift over weekends and holidays.
        missed: daysBetween(next, today) > 7,
        perMonth: Math.abs(last.amount!) * RANGES[cadence].perMonth,
      });
    }
  }
  return found.sort((a, b) => b.perMonth - a.perMonth || a.name.localeCompare(b.name));
}
