import type { Group, Listing } from "./directory.js";
import type { L, Lang } from "./site.js";

/**
 * Every fixed text of serain.si, English and German (D65). The HTML pages
 * (render.ts) and their Markdown twins for agents (agents.ts) read the same
 * texts, so the two cannot say different things.
 */
export const T = {
  skip: { en: "Skip to content", de: "Zum Inhalt" },
  navFeatures: { en: "What it does", de: "Was es kann" },
  navSecurity: { en: "Security", de: "Sicherheit" },
  navConnectors: { en: "Connectors", de: "Connectors" },
  switchTo: { en: "Deutsch", de: "English" },

  homeTitle: { en: "Serain · A personal AI agent you text over iMessage", de: "Serain · Ein persönlicher KI-Agent in iMessage" },
  homeDescription: {
    en: "Serain is an open-source personal AI agent that lives in iMessage and runs on your own server. Mail, calendar, research and memory, with a confirmation before anything that cannot be undone.",
    de: "Serain ist ein quelloffener persönlicher KI-Agent, der in iMessage wohnt und auf deinem eigenen Server läuft. Mail, Kalender, Recherche und Gedächtnis, mit Bestätigung vor allem, was sich nicht rückgängig machen lässt.",
  },
  headline: { en: "Text it like a friend.", de: "Schreib ihm wie einem Freund." },
  headline2: { en: "It handles the rest.", de: "Den Rest erledigt es." },
  sub: {
    en: "A personal AI agent in your iMessage. Open source, on your own server.",
    de: "Ein persönlicher KI-Agent in deinem iMessage. Open Source, auf deinem eigenen Server.",
  },
  ctaGithub: { en: "View on GitHub", de: "Auf GitHub ansehen" },
  ctaSetup: { en: "Setup guide", de: "Anleitung" },

  ipa: { en: "/səˈreɪn/ · noun", de: "/səˈreɪn/ · Substantiv" },
  definition: { en: "Fine rain that falls from a clear sky after sunset.", de: "Feiner Regen, der nach Sonnenuntergang aus klarem Himmel fällt." },
  defineAfter: { en: "Quiet, always there, speaks up when it matters.", de: "Leise, immer da, meldet sich, wenn es zählt." },

  featuresTitle: { en: "One chat for the things you keep putting off.", de: "Ein Chat für alles, was du vor dir herschiebst." },
  chapters: [
    { title: { en: "Mail that reads itself", de: "Mails, die sich selbst lesen" }, body: { en: "Notices what you are waiting for. Sends only after your 👍.", de: "Merkt, worauf du wartest. Sendet erst nach deinem 👍." } },
    { title: { en: "Your calendar in a sentence", de: "Dein Kalender in einem Satz" }, body: { en: "iCloud or Google. Free slots computed in code.", de: "iCloud oder Google. Freie Zeiten rechnet der Code." } },
    { title: { en: "It keeps an eye on things", de: "Es behält Dinge im Blick" }, body: { en: "Trains, prices, replies. It speaks up when something changes.", de: "Züge, Preise, Antworten. Es meldet sich, wenn sich was ändert." } },
    { title: { en: "It remembers what matters", de: "Es merkt sich, was zählt" }, body: { en: "Facts with provenance. You can see and correct all of it.", de: "Fakten mit Herkunft. Du kannst alles einsehen und korrigieren." } },
    { title: { en: "Talk, if you'd rather", de: "Sprich, wenn dir das lieber ist" }, body: { en: "Voice messages both ways, transcribed on your server.", de: "Sprachnachrichten in beide Richtungen, transkribiert auf deinem Server." } },
  ],

  securityTitle: { en: "It asks before it acts.", de: "Es fragt, bevor es handelt." },
  securityLead: {
    en: "Every tool has a level. Anything you cannot undo waits for your 👍.",
    de: "Jedes Tool hat eine Stufe. Was sich nicht rückgängig machen lässt, wartet auf dein 👍.",
  },
  levels: [
    { name: "read", how: { en: "Runs right away", de: "Läuft sofort" } },
    { name: "write_reversible", how: { en: "Runs, and you can undo it", de: "Läuft, und geht zurück" } },
    { name: "irreversible", how: { en: "Waits for your 👍", de: "Wartet auf dein 👍" } },
    { name: "money", how: { en: "Always asks. Never “yes, always”", de: "Fragt immer. Nie „ja, immer“" } },
  ],
  moneyEvery: { en: "👍 every time", de: "👍 jedes Mal" },
  moneyNever: { en: "yes, always", de: "ja, immer" },
  strictness: { en: "Level {n} of 4", de: "Stufe {n} von 4" },
  killTitle: { en: "One message stops everything.", de: "Eine Nachricht stoppt alles." },
  killBody: { en: "Read by code, not the model. Survives a restart.", de: "Gelesen vom Code, nicht vom Modell. Übersteht einen Neustart." },
  securityMore: { en: "The full security model", de: "Das ganze Sicherheitsmodell" },

  ownTitle: { en: "Yours, on your server.", de: "Deins, auf deinem Server." },
  ownLead: { en: "No hosted service, no account with us, no open port.", de: "Kein gehosteter Dienst, kein Konto bei uns, kein offener Port." },
  flow: [
    { name: { en: "Your iPhone", de: "Dein iPhone" }, sub: { en: "iMessage", de: "iMessage" } },
    { name: { en: "Photon", de: "Photon" }, sub: { en: "free plan", de: "Free-Plan" } },
    { name: { en: "Your server", de: "Dein Server" }, sub: { en: "4 GB VM", de: "4-GB-VM" } },
    { name: { en: "Supabase", de: "Supabase" }, sub: { en: "your project", de: "dein Projekt" } },
  ],
  wires: [
    { en: "chat", de: "Chat" },
    { en: "outbound", de: "ausgehend" },
    { en: "data", de: "Daten" },
  ],

  connTeaserTitle: { en: "Plugs into what you already use.", de: "Passt an das, was du schon nutzt." },
  connTeaser: { en: "Levels set by us, never by the provider.", de: "Stufen von uns, nie vom Anbieter." },
  allConnectors: { en: "All connectors", de: "Alle Connectors" },
  submitOne: { en: "Submit yours", de: "Eigenen einreichen" },

  startTitle: { en: "The sun goes down. Serain keeps going.", de: "Die Sonne geht unter. Serain macht weiter." },
  startLead: { en: "Free under AGPL-3.0. You bring the keys.", de: "Kostenlos unter AGPL-3.0. Die Schlüssel bringst du mit." },
  startComment: { en: "# then: docs/SETUP.md", de: "# danach: docs/SETUP.md" },
  copy: { en: "Copy", de: "Kopieren" },
  copied: { en: "Copied", de: "Kopiert" },

  connTitle: { en: "Connectors · Serain", de: "Connectors · Serain" },
  connDescription: {
    en: "The services Serain can use, with every tool and its level, and how to submit your own connector.",
    de: "Die Dienste, die Serain nutzen kann, mit jedem Tool und seiner Stufe, und wie du deinen eigenen Connector einreichst.",
  },
  connLead: {
    en: "Plugs into what you already use. Every tool carries the level we set, never the provider's.",
    de: "Passt an das, was du schon nutzt. Jedes Tool trägt die Stufe, die wir setzen, nie die des Anbieters.",
  },
  groups: {
    integration: {
      title: { en: "Built in", de: "Eingebaut" },
      sub: { en: "Part of the core, connected on your machine or in the server's env.", de: "Teil des Kerns, verbunden auf deinem Rechner oder in der Env des Servers." },
    },
    connection: {
      title: { en: "In the web interface", de: "Im Web-Interface" },
      sub: { en: "Connected with one click in your web interface.", de: "Mit einem Klick in deinem Web-Interface verbunden." },
    },
    community: {
      title: { en: "From the community", de: "Aus der Community" },
      sub: { en: "Reviewed in the open, added to your own instance.", de: "Öffentlich geprüft, in deine eigene Instanz eingebunden." },
    },
  } satisfies Record<Group, { title: L; sub: L }>,
  communityEmpty: { en: "None yet. Be the first.", de: "Noch keiner. Mach den Anfang." },
  search: { en: "Search connectors", de: "Connectors suchen" },
  filter: { en: "Category", de: "Kategorie" },
  filterAll: { en: "All", de: "Alle" },
  noMatch: { en: "No connector matches.", de: "Kein Connector passt." },
  readOnly: { en: "Read only", de: "Nur lesen" },
  readsWrites: { en: "Reads, writes reversibly", de: "Liest, schreibt umkehrbar" },
  readsActs: { en: "Reads, acts after confirmation", de: "Liest, handelt nach Bestätigung" },
  levelRead: { en: "read", de: "lesen" },
  levelWrite: { en: "write, reversible", de: "schreiben, umkehrbar" },
  source: { en: "Source", de: "Quelltext" },
  review: { en: "Review", de: "Review" },
  metaCategory: { en: "Category", de: "Kategorie" },
  metaGroup: { en: "Where", de: "Wo" },
  metaAccess: { en: "Access", de: "Zugriff" },
  metaBy: { en: "Built by", de: "Gebaut von" },
  metaLinks: { en: "More", de: "Mehr" },
  setupGuide: { en: "Setup guide", de: "Einrichtung" },
  connectTitle: { en: "Connect", de: "Verbinden" },
  communityConnect: { en: "Add its code to your instance.", de: "Bind seinen Code in deine Instanz ein." },
  instanceGuide: { en: "How instances work", de: "So funktionieren Instanzen" },
  actsTitle: { en: "What it may do", de: "Was es darf" },
  readOnlyNote: { en: "Reads only. It cannot send, change or delete anything.", de: "Liest nur. Es kann nichts senden, ändern oder löschen." },
  writesNote: {
    en: "Reads, and writes only what can be undone, in turns you started.",
    de: "Liest und schreibt nur, was sich rückgängig machen lässt, in Durchläufen, die du begonnen hast.",
  },
  toolsTitle: { en: "Tools", de: "Tools" },
  trust: {
    en: "Levels and descriptions live in Serain's code, never in the provider's. What the service returns counts as untrusted: it informs Serain, it never instructs it.",
    de: "Stufen und Beschreibungen stehen in Serains Code, nie in dem des Anbieters. Was der Dienst zurückgibt, gilt als nicht vertrauenswürdig: Es informiert Serain, es weist Serain nie an.",
  },
  trustCommunity: {
    en: "Community connectors run only in your own instance, once you added their code. Read it first.",
    de: "Community-Connectors laufen nur in deiner eigenen Instanz, wenn du ihren Code eingebunden hast. Lies ihn vorher.",
  },
  related: { en: "More connectors", de: "Weitere Connectors" },

  submitTitle: { en: "Submit a connector", de: "Connector einreichen" },
  submitPageTitle: { en: "Submit a connector · Serain", de: "Connector einreichen · Serain" },
  submitDescription: {
    en: "Submit a connector you built, or suggest a service Serain should know. Reviewed in the open on GitHub.",
    de: "Reich einen Connector ein, den du gebaut hast, oder schlag einen Dienst vor, den Serain kennen sollte. Öffentlich geprüft auf GitHub.",
  },
  submitLead: { en: "Built one, or want one? We review it in the open on GitHub.", de: "Einen gebaut oder einen gewünscht? Wir prüfen ihn öffentlich auf GitHub." },
  missingTitle: { en: "Missing a service?", de: "Fehlt ein Dienst?" },
  missingLead: { en: "Submit the connector you built, or tell us which one you want.", de: "Reich den Connector ein, den du gebaut hast, oder sag uns, welchen du willst." },
  kindBuilt: { en: "I built one", de: "Ich habe einen gebaut" },
  kindBuiltSub: { en: "Your code is in a repository and ready for review.", de: "Dein Code liegt in einem Repository und ist bereit für ein Review." },
  kindIdea: { en: "I have an idea", de: "Ich habe eine Idee" },
  kindIdeaSub: { en: "A service Serain should know. Someone may build it.", de: "Ein Dienst, den Serain kennen sollte. Vielleicht baut ihn jemand." },
  steps: {
    start: { en: "Before you start", de: "Bevor du anfängst" },
    service: { en: "Service", de: "Dienst" },
    tools: { en: "Tools", de: "Tools" },
    risks: { en: "Risks", de: "Risiken" },
    review: { en: "Review", de: "Prüfen" },
  },
  rulesLead: { en: "Every connector is reviewed against these rules. An idea does not need to meet them yet.", de: "Jeder Connector wird gegen diese Regeln geprüft. Eine Idee muss sie noch nicht erfüllen." },
  rules: [
    { en: "One catalog entry and one driver (D51). Tools, levels and descriptions are ours, never the provider's.", de: "Ein Katalogeintrag und ein Driver (D51). Tools, Stufen und Beschreibungen sind unsere, nie die des Anbieters." },
    { en: "Only `read` and `write_reversible`. Nothing that sends, deletes or pays.", de: "Nur `read` und `write_reversible`. Nichts, das sendet, löscht oder bezahlt." },
    { en: "Results are untrusted and private. Writing only in turns the owner started.", de: "Ergebnisse sind nicht vertrauenswürdig und privat. Schreiben nur in Durchläufen, die der Besitzer begonnen hat." },
    { en: "OAuth with PKCE, or a key sealed on the server. No scraping behind a login, no CAPTCHA solving.", de: "OAuth mit PKCE oder ein auf dem Server versiegelter Schlüssel. Kein Scraping hinter einem Login, kein CAPTCHA-Lösen." },
    { en: "Passes `pnpm typecheck` and `pnpm test`, fuzz tests included.", de: "Besteht `pnpm typecheck` und `pnpm test`, Fuzz-Tests eingeschlossen." },
  ],
  howBuild: { en: "How to build one", de: "So baust du einen" },
  fieldService: { en: "Name of the service", de: "Name des Dienstes" },
  fieldServiceHint: { en: "e.g. Todoist", de: "z. B. Todoist" },
  fieldWebsite: { en: "Website of the service", de: "Website des Dienstes" },
  fieldSource: { en: "Repository with your code", de: "Repository mit deinem Code" },
  fieldSourceHint: { en: "The catalog entry and the driver, shaped like an instance.", de: "Der Katalogeintrag und der Driver, aufgebaut wie eine Instanz." },
  fieldSummary: { en: "What Serain can do with it", de: "Was Serain damit kann" },
  fieldSummaryHint: { en: "One or two sentences, as they would appear in the directory.", de: "Ein oder zwei Sätze, so wie sie im Verzeichnis stünden." },
  toolsLead: {
    en: "Every tool with what it does for the owner and its level. Connectors only read or write reversibly.",
    de: "Jedes Tool mit dem, was es für den Besitzer tut, und seiner Stufe. Connectors lesen nur oder schreiben umkehrbar.",
  },
  fieldTools: { en: "Tools, one per line: name, what it does, level", de: "Tools, eins pro Zeile: Name, was es tut, Stufe" },
  toolName: { en: "Name", de: "Name" },
  toolLabel: { en: "What it does", de: "Was es tut" },
  toolLevel: { en: "Level", de: "Stufe" },
  toolAdd: { en: "Add a tool", de: "Tool hinzufügen" },
  toolRemove: { en: "Remove", de: "Entfernen" },
  fieldRisks: { en: "What could go wrong", de: "Was schiefgehen kann" },
  fieldRisksHint: {
    en: "What does a write change, and how does the owner undo it? What foreign text does the service return, like titles, notes or messages from others?",
    de: "Was ändert ein Schreibzugriff, und wie macht der Besitzer ihn rückgängig? Welchen fremden Text gibt der Dienst zurück, etwa Titel, Notizen oder Nachrichten anderer?",
  },
  reviewLead: { en: "This goes into the issue. On GitHub you pick the status and how it connects, and confirm the rules.", de: "Das kommt ins Issue. Auf GitHub wählst du den Status und die Anbindung und bestätigst die Regeln." },
  reviewEmpty: { en: "Not filled in", de: "Nicht ausgefüllt" },
  back: { en: "Back", de: "Zurück" },
  next: { en: "Next", de: "Weiter" },
  stepOf: { en: "Step {n} of {total}", de: "Schritt {n} von {total}" },
  submitButton: { en: "Continue on GitHub", de: "Weiter auf GitHub" },
  submitNote: {
    en: "Opens a prefilled issue on GitHub; you need an account there. Never paste tokens, passwords or personal data.",
    de: "Öffnet ein vorausgefülltes Issue auf GitHub; dafür brauchst du dort ein Konto. Füge nie Tokens, Passwörter oder persönliche Daten ein.",
  },
  afterTitle: { en: "What happens next", de: "Wie es weitergeht" },
  after: [
    {
      title: { en: "Issue on GitHub", de: "Issue auf GitHub" },
      text: { en: "Your submission opens as a public issue with the label connector.", de: "Deine Einreichung wird ein öffentliches Issue mit dem Label connector." },
    },
    {
      title: { en: "Review in the open", de: "Öffentliches Review" },
      text: { en: "We read the code against the rules and ask in the issue when something is unclear.", de: "Wir lesen den Code gegen die Regeln und fragen im Issue nach, wenn etwas unklar ist." },
    },
    {
      title: { en: "Pull request", de: "Pull Request" },
      text: { en: "An accepted connector gets an entry in the directory, in a pull request that links the issue.", de: "Ein angenommener Connector bekommt einen Eintrag im Verzeichnis, in einem Pull Request, der das Issue verlinkt." },
    },
    {
      title: { en: "Listed", de: "Gelistet" },
      text: { en: "It appears under From the community, with its review linked. Owners add its code to their instance.", de: "Er erscheint unter Aus der Community, mit verlinktem Review. Besitzer binden seinen Code in ihre Instanz ein." },
    },
  ],

  faqTitle: { en: "Before you ask.", de: "Bevor du fragst." },
  /** Questions people ask about Serain, answered first and plainly; the page, its JSON-LD, its Markdown twin and llms.txt read the same list. */
  faq: [
    {
      q: { en: "What is Serain?", de: "Was ist Serain?" },
      a: {
        en: "Serain is an open-source personal AI agent for one person. You text it over iMessage, and it runs around the clock on your own server: it reads and cleans up your mail, keeps your calendar, reminds you, researches the web and remembers what matters to you.",
        de: "Serain ist ein quelloffener persönlicher KI-Agent für eine Person. Du schreibst ihm über iMessage, und es läuft rund um die Uhr auf deinem eigenen Server: Es liest und räumt deine Mails auf, führt deinen Kalender, erinnert dich, recherchiert im Web und merkt sich, was dir wichtig ist.",
      },
    },
    {
      q: { en: "Is Serain an app or a hosted service?", de: "Ist Serain eine App oder ein Onlinedienst?" },
      a: {
        en: "Neither. There is no app to install and no account with us. You run your own copy on a Linux server and bring every account and key yourself. You text it in the Messages app you already have.",
        de: "Weder noch. Es gibt keine App zum Installieren und kein Konto bei uns. Du betreibst deine eigene Kopie auf einem Linux-Server und bringst jedes Konto und jeden Schlüssel selbst mit. Du schreibst ihm in der Nachrichten-App, die du schon hast.",
      },
    },
    {
      q: { en: "What does it cost?", de: "Was kostet es?" },
      a: {
        en: "The code is free under AGPL-3.0. You pay for what you bring: Claude API usage per token, capped by a monthly budget you set (20 $ by default), and a server with 4 GB of RAM, typically a few euros a month. Supabase and Photon work on their free plans.",
        de: "Der Code ist kostenlos unter AGPL-3.0. Du zahlst, was du mitbringst: die Claude-API pro Token, gedeckelt durch ein Monatsbudget, das du festlegst (standardmäßig 20 $), und einen Server mit 4 GB RAM, meist ein paar Euro im Monat. Supabase und Photon reichen im Free-Plan.",
      },
    },
    {
      q: { en: "What do I need to run it?", de: "Was brauche ich dafür?" },
      a: {
        en: "A Linux server with Docker and at least 4 GB of RAM, a Supabase project, a Photon account for iMessage, an Anthropic API key and an Apple device with iMessage. Mail, calendars, web search and the web interface are optional.",
        de: "Einen Linux-Server mit Docker und mindestens 4 GB RAM, ein Supabase-Projekt, ein Photon-Konto für iMessage, einen Anthropic-API-Key und ein Apple-Gerät mit iMessage. Mail, Kalender, Websuche und das Web-Interface sind optional.",
      },
    },
    {
      q: { en: "Does it work with Android, WhatsApp or Telegram?", de: "Funktioniert es mit Android, WhatsApp oder Telegram?" },
      a: {
        en: "No. Its only channel is iMessage, through Photon, so you need an iPhone, iPad or Mac to text it.",
        de: "Nein. Sein einziger Kanal ist iMessage, über Photon. Du brauchst also ein iPhone, iPad oder einen Mac, um ihm zu schreiben.",
      },
    },
    {
      q: { en: "Can it send mail or delete things without asking?", de: "Kann es ohne Nachfrage Mails senden oder etwas löschen?" },
      a: {
        en: "No. Every tool has a level. Reading runs right away and reversible changes can be undone, but anything you cannot undo, like sending a mail, waits for your 👍 on a preview the code builds from the exact recipients and text. Anything that costs money asks every time. Mail is never deleted for good.",
        de: "Nein. Jedes Tool hat eine Stufe. Lesen läuft sofort, und umkehrbare Änderungen lassen sich zurücknehmen. Was sich nicht rückgängig machen lässt, etwa eine Mail senden, wartet auf dein 👍 unter einer Vorschau, die der Code aus genau den Empfängern und dem Text baut. Was Geld kostet, fragt jedes Mal. Mails löscht es nie endgültig.",
      },
    },
    {
      q: { en: "How do I stop it?", de: "Wie stoppe ich es?" },
      a: {
        en: "Text “serain stop”. Code, not the model, reads it and locks every tool, pending approvals included, until you text “serain resume”. The state is stored in the database, so a restart does not lift it.",
        de: "Schreib „serain stopp“. Der Code liest das, nicht das Modell, und sperrt jedes Tool, auch offene Freigaben, bis du „serain weiter“ schreibst. Der Zustand liegt in der Datenbank, ein Neustart hebt ihn also nicht auf.",
      },
    },
    {
      q: { en: "Which AI model does it use?", de: "Welches KI-Modell nutzt es?" },
      a: {
        en: "Claude, through the Claude Agent SDK, with your own Anthropic API key. OpenRouter is an optional fallback. Web research runs in a separate executor model that never sees your mail or your memory.",
        de: "Claude, über das Claude Agent SDK, mit deinem eigenen Anthropic-API-Key. OpenRouter ist ein optionaler Fallback. Web-Recherche läuft in einem eigenen Executor-Modell, das deine Mails und dein Gedächtnis nie sieht.",
      },
    },
    {
      q: { en: "Where does my data live?", de: "Wo liegen meine Daten?" },
      a: {
        en: "On your own server and in your own Supabase project. Credentials are sealed with a key only your server has, and the audit log never holds mail contents, calendar titles or bank data. Your messages pass through Photon, and model calls go to Anthropic.",
        de: "Auf deinem eigenen Server und in deinem eigenen Supabase-Projekt. Zugangsdaten sind mit einem Schlüssel versiegelt, den nur dein Server hat, und das Audit-Log enthält nie Mailinhalte, Kalendertitel oder Bankdaten. Deine Nachrichten laufen über Photon, Modellaufrufe gehen an Anthropic.",
      },
    },
  ],
  faqMore: { en: "Everything else, in the README", de: "Alles Weitere im README" },

  /** A connector page's description: what Serain is, then the connector's own summary. */
  connectorDescription: {
    en: "{name} in Serain, the open-source personal AI agent you text over iMessage. {summary}",
    de: "{name} in Serain, dem quelloffenen persönlichen KI-Agenten in iMessage. {summary}",
  },
  appCategory: { en: "Personal AI agent", de: "Persönlicher KI-Agent" },

  // The Markdown twins for agents (agents.ts).
  mdLinks: { en: "Links", de: "Links" },
  mdOtherLanguage: { en: "Deutsche Fassung", de: "English version" },
  mdSubmitForm: { en: "Open the submission form on GitHub", de: "Einreichungsformular auf GitHub öffnen" },
  mdLevel: { en: "Level", de: "Stufe" },

  footerLine: { en: "A personal AI agent you text over iMessage.", de: "Ein persönlicher KI-Agent in iMessage." },
  footerLicense: { en: "Open source under AGPL-3.0.", de: "Open Source unter AGPL-3.0." },
  footerSetup: { en: "Setup", de: "Einrichtung" },
  footerArchitecture: { en: "Architecture", de: "Architektur" },
  footerSecurity: { en: "Security policy", de: "Sicherheitsrichtlinie" },
  footerLegal: { en: "Legal notes", de: "Rechtliches" },
  trademark: {
    en: "iMessage is a trademark of Apple Inc. Serain is not affiliated with Apple. Logos belong to their owners. Conversations on this page are illustrations.",
    de: "iMessage ist eine Marke von Apple Inc. Serain steht in keiner Verbindung zu Apple. Logos gehören ihren Inhabern. Die Chats auf dieser Seite sind Illustrationen.",
  },
  notFoundTitle: { en: "Not found · Serain", de: "Nicht gefunden · Serain" },
} as const;

/** How much a listing may do, in a few words. */
export function access(listing: Listing, lang: Lang): string {
  if (listing.tools?.length) return (listing.tools.every((tool) => tool.level === "read") ? T.readOnly : T.readsWrites)[lang];
  return (listing.acts ? T.readsActs : T.readOnly)[lang];
}

/** What the connector may do, in one sentence: the listing's own words, or what its levels allow. Plain text, not HTML. */
export function actsOf(listing: Listing, lang: Lang): string {
  if (listing.acts) return listing.acts[lang];
  return (listing.tools?.some((tool) => tool.level !== "read") ? T.writesNote : T.readOnlyNote)[lang];
}
