import { BUILT_IN_CONNECTORS, type ConnectorTier } from "../../src/connectors/catalog.js";
import { COMMUNITY, type CommunityConnector } from "./community.js";
import type { L } from "./site.js";

/**
 * Everything the connector directory lists, in three groups:
 *
 * - `integration`: built into the core, connected on the owner's machine
 *   (`pnpm integration connect …`) or through an env value.
 * - `connection`: the web interface's catalog (D51). Name, summary, tools and
 *   levels come from `src/connectors/catalog.ts` itself, so the page cannot
 *   promise more than the code does; only the German texts are added here.
 * - `community`: reviewed submissions from `community.ts`.
 */

export type Category = CommunityConnector["category"];
export type Group = "integration" | "connection" | "community";

export interface Tool {
  name: string;
  label: L | { en: string };
  level: ConnectorTier;
}

export interface Listing {
  id: string;
  name: string;
  group: Group;
  category: Category;
  summary: L | { en: string };
  /** What it may do beyond reading, in plain words. Without: read only. */
  acts?: L;
  /** How it is connected. */
  connect?: L;
  command?: string;
  tools?: readonly Tool[];
  /** The service's own logo, files in site/images/logos. Without: its initial. */
  logos?: readonly string[];
  author?: string;
  source?: string;
  issue?: number;
}

export const CATEGORY: Record<Category, L> = {
  mail: { en: "Mail", de: "Mail" },
  calendar: { en: "Calendar", de: "Kalender" },
  apple: { en: "Apple", de: "Apple" },
  health: { en: "Health", de: "Gesundheit" },
  finance: { en: "Finance", de: "Finanzen" },
  web: { en: "Web", de: "Web" },
  media: { en: "Video", de: "Video" },
  productivity: { en: "Productivity", de: "Produktivität" },
  home: { en: "Home", de: "Zuhause" },
};

const MAIL_ACTS: L = {
  en: "Sends only after you confirm recipients and text. Cleans up after one preview and never deletes for good.",
  de: "Sendet erst, wenn du Empfänger und Text bestätigt hast. Räumt nach einer Vorschau auf und löscht nie endgültig.",
};

const INTEGRATIONS: readonly Listing[] = [
  {
    id: "gmail",
    logos: ["gmail.svg"],
    name: "Gmail",
    group: "integration",
    category: "mail",
    summary: {
      en: "Every folder, attachments opened in the sandbox.",
      de: "Alle Ordner, Anhänge geöffnet in der Sandbox.",
    },
    acts: MAIL_ACTS,
    connect: { en: "Your own Google Cloud OAuth app, then", de: "Eigene Google-Cloud-OAuth-App, dann" },
    command: "pnpm integration connect google",
  },
  {
    id: "imap",
    name: "IMAP & SMTP",
    group: "integration",
    category: "mail",
    summary: {
      en: "Any mailbox, from GMX to your own server.",
      de: "Jedes Postfach, von GMX bis zum eigenen Server.",
    },
    acts: MAIL_ACTS,
    connect: { en: "An app password of the mailbox, then", de: "Ein App-Passwort des Postfachs, dann" },
    command: "pnpm integration connect gmx",
  },
  {
    id: "google-calendar",
    logos: ["google-calendar.svg"],
    name: "Google Calendar",
    group: "integration",
    category: "calendar",
    summary: {
      en: "Events and free slots, computed in code.",
      de: "Termine und freie Zeiten, im Code berechnet.",
    },
    acts: {
      en: "Creates and moves events. Deleting and invitations only after your confirmation.",
      de: "Legt Termine an und verschiebt sie. Löschen und Einladungen nur nach deiner Bestätigung.",
    },
    connect: { en: "The same Google app as Gmail", de: "Dieselbe Google-App wie Gmail" },
    command: "pnpm integration connect google",
  },
  {
    id: "icloud-calendar",
    logos: ["icloud.svg"],
    name: "iCloud Calendar",
    group: "integration",
    category: "calendar",
    summary: {
      en: "Over CalDAV, the right calendar for each event.",
      de: "Über CalDAV, pro Termin der passende Kalender.",
    },
    acts: {
      en: "Creates and moves events, deletes only after your confirmation. Never sends invitations through iCloud.",
      de: "Legt Termine an und verschiebt sie, löscht nur nach deiner Bestätigung. Verschickt über iCloud nie Einladungen.",
    },
    command: "pnpm integration connect icloud",
  },
  {
    id: "apple",
    logos: ["apple.svg"],
    name: "Apple Calendar, Reminders, Contacts",
    group: "integration",
    category: "apple",
    summary: {
      en: "Read only, through the optional Mac companion.",
      de: "Nur lesen, über den optionalen Mac-Companion.",
    },
    connect: { en: "Mac companion, see companion/README.md", de: "Mac-Companion, siehe companion/README.md" },
  },
  {
    id: "tavily",
    logos: ["tavily.svg"],
    name: "Tavily",
    group: "integration",
    category: "web",
    summary: {
      en: "Web search. Links only to pages Serain opened.",
      de: "Websuche. Links nur zu Seiten, die Serain geöffnet hat.",
    },
    connect: { en: "API key in the server's env", de: "API-Key in der Env des Servers" },
    command: "TAVILY_API_KEY",
  },
  {
    id: "youtube",
    logos: ["youtube.svg"],
    name: "YouTube",
    group: "integration",
    category: "media",
    summary: {
      en: "Watches with picture and sound. Only the link leaves the server.",
      de: "Schaut mit Bild und Ton. Nur der Link verlässt den Server.",
    },
    connect: { en: "OpenRouter key in the server's env", de: "OpenRouter-Key in der Env des Servers" },
    command: "OPENROUTER_API_KEY",
  },
  {
    id: "social-video",
    logos: ["tiktok.svg", "instagram.svg", "x.svg"],
    name: "TikTok, Instagram, X",
    group: "integration",
    category: "media",
    summary: {
      en: "Off by default. Downloads in the sandbox, at your own risk.",
      de: "Standardmäßig aus. Lädt in der Sandbox, auf eigenes Risiko.",
    },
    connect: { en: "Turned on in the server's env", de: "Eingeschaltet in der Env des Servers" },
    command: "SERAIN_MEDIA_DOWNLOAD=1",
  },
];

/** What the catalog does not say: category and the German texts, per service and tool. */
const CATALOG_EXTRA: Record<string, { category: Category; logos: readonly string[]; summary: string; tools: Record<string, string> }> = {
  coros: {
    category: "health",
    logos: ["coros.png"],
    summary: "Schlaf, HRV, Erholung, Trainingslast und Aktivitäten von deiner COROS-Uhr. Nur lesen.",
    tools: {
      coros_daily_health: "Tageswerte: Schritte, Stress, Schlaf",
      coros_sleep: "Schlaf",
      coros_sleep_hrv: "HRV im Schlaf",
      coros_recovery: "Erholung",
      coros_resting_hr: "Ruhepuls",
      coros_stress: "Stress",
      coros_training_load: "Trainingslast",
      coros_fitness: "VO2max, Schwelle, Prognosen",
      coros_activities: "Aktivitäten suchen",
      coros_activity: "Eine Aktivität im Detail",
      coros_schedule: "Trainingsplan der Woche",
    },
  },
  bank: {
    category: "finance",
    // The bank is the owner's own; what it connects through is Enable Banking.
    logos: ["enable-banking.png"],
    summary:
      "Kontostand und Umsätze deines Bankkontos, nur lesen. Überweisen kann Serain damit nicht. Freigabe in der App deiner Bank, über Enable Banking.",
    tools: {
      bank_balance: "Kontostand",
      bank_transactions: "Umsätze der letzten 90 Tage",
      bank_subscriptions: "Abos und wiederkehrende Abbuchungen",
    },
  },
};

const WEB_INTERFACE: L = { en: "Web interface, under Connections", de: "Web-Interface, unter Verbindungen" };

function fromCatalog(): Listing[] {
  return BUILT_IN_CONNECTORS.map((info) => {
    const extra = CATALOG_EXTRA[info.id];
    if (!extra) throw new Error(`site/content/directory.ts: ${info.id} from the catalog has no category and no German text.`);
    return {
      id: info.id,
      name: info.name,
      group: "connection",
      category: extra.category,
      logos: extra.logos,
      summary: { en: info.summary, de: extra.summary },
      connect: WEB_INTERFACE,
      tools: info.tools.map((tool) => {
        const de = extra.tools[tool.name];
        if (!de) throw new Error(`site/content/directory.ts: tool ${tool.name} has no German label.`);
        return { name: tool.name, label: { en: tool.label, de }, level: tool.level };
      }),
    };
  });
}

const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ID = /^[a-z][a-z0-9_-]{1,30}$/;
const TOOL = /^[a-z][a-z0-9_]{1,63}$/;
/** Ids that are pages of their own under /connectors/. */
const RESERVED: ReadonlySet<string> = new Set(["submit"]);
const LEVELS: ReadonlySet<string> = new Set<ConnectorTier>(["read", "write_reversible"]);

/**
 * All listings, checked: one id per listing, one name per tool across the
 * whole directory, levels only `read` and `write_reversible`, community
 * sources over https. Anything else stops the build.
 */
export function directory(community: readonly CommunityConnector[] = COMMUNITY): Listing[] {
  const listings: Listing[] = [
    ...INTEGRATIONS,
    ...fromCatalog(),
    ...community.map(
      (entry): Listing => ({
        id: entry.id,
        name: entry.name,
        group: "community",
        category: entry.category,
        summary: entry.summary,
        author: entry.author,
        source: entry.source,
        issue: entry.issue,
        tools: entry.tools.map((tool) => ({ name: tool.name, label: { en: tool.label }, level: tool.level })),
      }),
    ),
  ];
  const ids = new Set<string>();
  const tools = new Set<string>();
  for (const listing of listings) {
    if (!ID.test(listing.id) || ids.has(listing.id) || RESERVED.has(listing.id)) throw new Error(`Connector directory: id "${listing.id}" is invalid, reserved or exists twice.`);
    ids.add(listing.id);
    if (listing.group !== "community") continue;
    if (!HANDLE.test(listing.author ?? "")) throw new Error(`Connector directory: ${listing.id} has no valid GitHub handle.`);
    if (!/^https:\/\/[^\s"'<>]+$/.test(listing.source ?? "")) throw new Error(`Connector directory: ${listing.id} needs an https source.`);
    if (!Number.isInteger(listing.issue) || (listing.issue ?? 0) < 1) throw new Error(`Connector directory: ${listing.id} needs the number of its issue.`);
    if (!listing.tools?.length) throw new Error(`Connector directory: ${listing.id} lists no tools.`);
  }
  for (const listing of listings) {
    for (const tool of listing.tools ?? []) {
      if (!TOOL.test(tool.name) || tools.has(tool.name)) throw new Error(`Connector directory: tool "${tool.name}" is invalid or exists twice.`);
      if (!LEVELS.has(tool.level)) throw new Error(`Connector directory: tool ${tool.name} has level ${tool.level}; connectors only read or write reversibly.`);
      tools.add(tool.name);
    }
  }
  return listings;
}
