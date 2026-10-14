import { PROPOSALS } from "../config/memory.js";
import { owner } from "../config/owner.js";
import type { FactArea } from "../memory/areas.js";

/**
 * Built-in playbooks (audit 2026-10-05): how Serain approaches finding a
 * meeting time, a trip, and research on money, health or law. Shown through the
 * same path as the owner's approved procedures (D42): only when the message
 * fits, as part of the `<context>`. The system prompt stays stable (D47); if
 * they stood there, every turn would pay for guides of which almost none fits.
 *
 * **No safety rule stands in a playbook.** What a tool may do is checked by
 * the registry; a playbook is text in the context and never reaches it, just
 * like a procedure. It is no style either: how Serain writes stands only in
 * the style block (D23).
 *
 * **Recognition is by keywords in the code only**, not, as with the owner's
 * procedures, also by embedding. The playbooks are fixed, so their triggers can
 * be written out as word stems, and that is testable: the threshold 0.5 from
 * D42 is not calibrated, and a match by similarity would hang on a paid call.
 * What a keyword misses does not stand in the context; the model still knows
 * the tool itself (calendar_free, thorough).
 *
 * Keywords exist in English and German (`en`, `de`). In any other language no
 * playbook is shown and the turn runs on the system prompt alone. That is
 * acceptable because a playbook is guidance, never a limit.
 *
 * **A playbook fetches its memory itself** (memory package of 2026-10-10).
 * "What is in memory you don't ask about" only helps when it is in the
 * context; but recall searches by the message, and "find me a flight to Rome"
 * does not sound like the departure airport. So a playbook names the areas from
 * which it needs knowledge (`areas`) and words by which the right facts in them
 * can be recognised (`recallTerms`); `buildMemoryContext` adds up to
 * `MEMORY.playbookFactLimit` facts from there.
 */

export interface Playbook {
  id: string;
  title: string;
  /** Word stems in the message by which a fitting task can be recognised. */
  keywords: RegExp;
  body: readonly string[];
  /** Memory areas from which this playbook needs facts. Without: only the normal recall. */
  areas?: readonly FactArea[];
  /**
   * Words by which the fitting facts in them can be recognised, English and
   * German (the database compares them after German stemming).
   */
  recallTerms?: string;
}

/** Any of the given patterns, case-insensitive: one per language. */
function anyOf(...patterns: readonly RegExp[]): RegExp {
  return new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"), "i");
}

/** A word announcing that someone will get in touch ("meldet sich", "schreibt", "rückmeldung"). */
const ANNOUNCE_DE = "(?:meld\\w*|rückmeld\\w*|zurück\\w*|antwort\\w*|bescheid|schreib\\w*|schick\\w*)";
/** The same in English ("gets back to me", "will reply", "let me know"). */
const ANNOUNCE_EN = "(?:get(?:s|ting)?\\s+back|hear(?:s|ing)?\\s+back|repl(?:y|ies|ying)|respond\\w*|answer\\w*|be\\s+in\\s+touch|let\\s+me\\s+know|writ(?:e|es|ing)|send\\w*)";
const NOT_LETTER_BEFORE = "(?<![a-zäöüß])";
const NOT_LETTER_AFTER = "(?![a-zäöüß])";

export const PLAYBOOKS: readonly Playbook[] = [
  {
    // Addendum to D62 of 2026-10-10 (decision 7). The approach stands here, the limit in the code
    // (`src/security/unasked.ts`): unasked only from the owner's own message, with the day in their words.
    // First, because "die versicherung meldet sich bis freitag" also sounds like money and there are two slots.
    id: "von-selbst",
    title: "Set up on your own",
    keywords: new RegExp(
      [
        "geburtstag",
        `${NOT_LETTER_BEFORE}(?:geb\\.|bday|b-day|birthday|geburi)`,
        `${NOT_LETTER_BEFORE}${ANNOUNCE_DE}[^.?!]{0,60}${NOT_LETTER_BEFORE}bis${NOT_LETTER_AFTER}`,
        `${NOT_LETTER_BEFORE}bis${NOT_LETTER_AFTER}[^.?!]{0,60}${NOT_LETTER_BEFORE}${ANNOUNCE_DE}`,
        `${NOT_LETTER_BEFORE}${ANNOUNCE_EN}[^.?!]{0,60}${NOT_LETTER_BEFORE}by${NOT_LETTER_AFTER}`,
        `${NOT_LETTER_BEFORE}by${NOT_LETTER_AFTER}[^.?!]{0,60}${NOT_LETTER_BEFORE}${ANNOUNCE_EN}`,
      ].join("|"),
      "i",
    ),
    body: [
      `If ${owner.name} mentions a birthday with a day (“anna's birthday is on 14 March”), you set up a yearly`,
      "reminder without asking: set_reminder with repeat yearly and unasked true, on the day itself at 09:00 (if the day has",
      "passed this year, from next year on), as text a short sentence like “it's anna's birthday today”. Without a day you set up nothing.",
      `If ${owner.name} says someone will get back by a certain day (“the insurance will get back to me by friday”), you set up`,
      "a watcher with watch_create: mail_arrives, from with the sender as it will appear in the mail (name or",
      "part of the address, from your memory if you know it), report_if_none true, until on that day at 18:00,",
      "unasked true.",
      `You tell ${owner.name} both in your answer in half a sentence, lowercase, instead of asking (“i'll remind you every`,
      "year on 14 march”, “i'll tell you if nothing has come by friday”). If one already exists, you say nothing about it.",
    ],
    // Who "the insurance" or "the landlord" is, so the watcher knows the right sender.
    areas: ["self", "people"],
    recallTerms:
      "Versicherung Krankenkasse Bank Vermieter Hausverwaltung Arzt Steuerberater Anwalt Firma Arbeitgeber " +
      "insurance bank landlord doctor accountant lawyer company employer",
  },
  {
    id: "terminfindung",
    title: "Finding a meeting time",
    keywords: anyOf(
      /\b(termin\w*\s+(zu\s+)?(finden|ausmachen|vereinbaren|abstimmen|vorschlagen)|(treffen|call|meeting|telefonat|essen)\s+(zu\s+)?(ausmachen|vereinbaren|finden|planen)|wann\s+(hab|habe|hätte|hast|hättest)\s+(ich|du)\b[^.?!]{0,30}\bzeit|freie?n?\s+(zeiten|slots?|termine)|slots?|zeitfenster|verfügbarkeit\w*)\b/,
      /\b((find|schedule|arrange|set\s+up|propose|suggest)\s+(a\s+|some\s+)?(time|times|slot|slots|meeting|call|date)|when\s+(am|are|is)\s+(i|you|we)\s+free|free\s+(time|times|slots?)|time\s*slots?|availability)\b/,
    ),
    body: [
      "Free times come from calendar_free, never from your head: at most three suggestions, spread over different days.",
      `Duration if ${owner.name} says nothing: call 30 min, meeting or coffee 60 min, dinner 90 min. Travel time around events with a place`,
      "calendar_free calculates itself; if the new meeting is somewhere else, you pass buffer_minutes for the way there.",
      "A suggestion right after work or late in the evening is not a good one; then rather another day.",
      `${owner.name} gets the suggestions so that they can forward them, one line per slot. If they say you should send them`,
      "to someone, that goes as a mail through mail_send, with a preview.",
      "If nothing suits the other side, you search a second time with a new period. After two rounds without agreement",
      `you hand back to ${owner.name} instead of pushing more suggestions.`,
      "Once the time is set, you enter the event.",
    ],
    // Where the owner works and lives (travel time), and when they want meetings.
    areas: ["places", "preferences"],
    recallTerms:
      "Termin Meeting Call Treffen Uhr morgens vormittags nachmittags abends Arbeit Büro arbeitet wohnt " +
      "meeting call morning afternoon evening work office works lives",
  },
  {
    id: "reise",
    title: "Planning a trip",
    keywords: anyOf(
      /\b(reise\w*|flug|flüge\w*|fliegen|hotels?|unterkunft|airbnb|übernachtung\w*|zugverbindung\w*|bahnfahrt\w*|urlaub\w*|trip|städtetrip|mietwagen|check-?in)\b/,
      /\b(trips?|travel\w*|flights?|flying|fly\s+to|hotels?|accommodation|airbnb|vacation\w*|city\s+break|rental\s+car|car\s+rental|train\s+(connection|ride|journey)s?|check-?in)\b/,
    ),
    body: [
      "Before the research only what really determines the search counts: destination, dates (fixed or flexible), how many",
      "people. Whatever of that is in memory (departure airport, rail card, preferences) you don't ask about.",
      "The task for run_task asks for final prices for all people with luggage and fees, times with changes and",
      "total duration.",
      `${owner.name} gets one recommendation with a reason. An alternative only if it is clearly cheaper or faster.`,
      `You can't book, ${owner.name} does that; you tell them where.`,
    ],
    // Departure airport and home town stand under places, rail card or seat mostly under preferences, sometimes under self.
    areas: ["preferences", "places", "self"],
    recallTerms:
      "Flughafen Abflug fliegt Flug Bahncard Bahn Zug Ticket Hotel Unterkunft Sitzplatz Gepäck Reise Urlaub wohnt " +
      "airport flies flight railcard train ticket hotel seat luggage trip travel vacation lives",
  },
  {
    id: "unterwegs",
    title: "Getting around by train and bus",
    keywords: anyOf(
      /\b(s-?bahn\w*|u-?bahn\w*|zug|züge\w*|zugverbindung\w*|bahnverbindung\w*|bus|busse|trams?|tramlinie\w*|straßenbahn\w*|regionalbahn|abfahrt\w*|fahrplan\w*|ersatzverkehr|schienenersatz\w*|gleis\w*|verbindung(en)?\s+(nach|zum|zur|ab|richtung)|wie\s+komm(e)?\s+ich\s+(am\s+besten\s+|jetzt\s+|heute\s+|morgen\s+)?(nach|zum|zur|zu|ins?|heim|hin|dahin|dorthin|von))\b/,
      /\b(trains?|buses|bus|trams?|subway|metro|underground|tube|commuter\s+rail|departures?|timetables?|platform|replacement\s+bus\w*|connections?\s+(to|from)|how\s+do\s+i\s+get\s+(to|home|there|from))\b/,
    ),
    body: [
      `Journeys by train, bus and tram, today or soon. Where ${owner.name} sets off: what they say, else where they are according to <current>,`,
      "else their home town or home station from memory. If one of these is there, you don't ask. Without",
      "a time, from now on.",
      "The task for run_task with screenshot: true asks for the next two to three connections from the journey planner",
      "of the rail operator or transit authority: departure, arrival, changes, platform, plus delays, cancellations, disruptions and",
      "replacement services on the route.",
      "If memory holds a regional or national travel pass, a rail card or a season ticket, you calculate with it; otherwise you name the",
      "fitting ticket with its price.",
      `${owner.name} gets the first connection they can make, with platform; if something is cancelled or replacement services run, that`,
      "comes first. A trip with an overnight stay follows the playbook for trips.",
    ],
    areas: ["places", "preferences", "self"],
    recallTerms:
      "wohnt Wohnort Bahnhof Haltestelle Deutschlandticket Bahncard Ticket Abo Bahn Zug Bus pendelt Arbeit Büro " +
      "lives home station stop pass railcard ticket season train bus commutes work office",
  },
  {
    // D63, building block F: the occasion ("where does the spam come from, take me off") and everything under data protection law.
    id: "datenschutz",
    title: "Data protection, spam, address brokers",
    keywords: anyOf(
      /\b(dsgvo|datenschutz\w*|auskunft\s*(nach|gem|art)\w*|art\.?\s*1[57]\b|art\.?\s*21\b|lösch(ung|en)\s+(meiner|der|aller)\s+daten|adresshändler\w*|datenhändler\w*|datenbroker\w*|robinson\w*|spam\w*|werbemails?|werbung\s+(abbestellen|stoppen|widersprechen)|austragen|trag\s+mich\b[^.?!]{0,30}\baus|datenle(ck|aks?)\w*|leak\w*|woher\s+haben\s+die\s+(meine|mein)\b)/,
      /\b(gdpr|data\s+protection|privacy|(subject\s+)?access\s+request|right\s+to\s+(access|erasure|be\s+forgotten|object)|delete\s+(all\s+)?my\s+data|data\s+brokers?|address\s+brokers?|spam\w*|marketing\s+e?mails?|unsubscribe\w*|data\s+(leak|breach)\w*|leak\w*|where\s+did\s+they\s+get\s+my)\b/,
    ),
    body: [
      `Where something comes from analyze_data shows through the headers: To/Delivered-To says to which of ${owner.possessive} addresses`,
      "it goes, Return-Path, Received and the domain in List-Unsubscribe say who sends it.",
      "First separate, then act. Newsletters and advertising with an unsubscribe header lie in the inbox: mail_senders with",
      "folder inbox shows them, unsubscribing is done with mail_cleanup after a preview. That is “take me off wherever possible”, even",
      `when ${owner.name} asks about spam. Real companies (imprint, constant domain, shops, address brokers, mailing services)`,
      "that still write or have bought their address: there the law works.",
      "Leak spam (throwaway domains, changing senders, forged brands): no request, no unsubscribing, both",
      "only confirm that the address is alive. It mostly already lies in the spam folder; you say so in one sentence and offer",
      `to empty the folder with mail_spam_folder. A new address you mention only if ${owner.name} asks what else helps.`,
      "For real companies in a mail: access under Art. 15 GDPR including the source of the data (para. 1 lit. g), erasure under",
      "Art. 17 and objection to advertising under Art. 21 para. 2 (applies at once, without giving reasons). The recipient is the",
      "data protection contact from the company's privacy policy (run_task), never an address from the advertising mail. Several",
      `companies go with mail_send_each from ${owner.possessive} address, matter-of-fact, with their name and the affected mail address, without`,
      "further data.",
      "The deadline is one month (Art. 12 para. 3). For that you set up a mission with mission_start, a look after 31 days;",
      `you note replies. Without a reply remind once, after that you suggest to ${owner.name} a complaint to the supervisory authority`,
      "(for companies in Hesse the HBDI, otherwise the authority at the company's seat), and you write the text.",
      `Advertising by post in Germany stops with the Robinson list, entered through its form with web_form. Which data leaks ${owner.possessive}`,
      "address is in, the HPI Identity Leak Checker tells: web_form with their mail address, the result comes as a mail.",
    ],
    areas: ["self"],
    recallTerms: "Mailadresse Adresse Name wohnt Anschrift email address name lives",
  },
  {
    // D63, building block F: rail and flight.
    id: "fahrgastrechte",
    title: "Passenger rights for rail and air",
    keywords: anyOf(
      /\b(verspätung\w*|verspätet|zu\s+spät\s+angekommen|ausgefallen\w*|zugausfall|annull\w*|gestrichen\w*|fahrgastrecht\w*|entschädigung\w*|anschluss\s+verpasst)\b/,
      /\b(delay(s|ed)?|arrived\s+late|cancell?ed|cancell?ations?|passenger\s+rights|compensation|missed\s+(my\s+|the\s+)?connection)\b/,
    ),
    body: [
      "Rail in Germany: from 60 minutes of delay at the destination there is 25 %, from 120 minutes 50 % of the fare; with the Deutschlandticket",
      "a small fixed amount per case, paid out only from a minimum sum. Flight (EU Regulation 261/2004): depending on the",
      "distance 250, 400 or 600 € for at least three hours of arrival delay or a short-notice cancellation,",
      `except in extraordinary circumstances. You check amounts and limits with run_task thorough before you tell ${owner.name}.`,
      "Ticket or booking you look for in the mail, the delay is proven by the provider's own information. The claim is filed with the",
      "provider itself, through its form with web_form (rail in the customer account, if it is in the vault); never through",
      "portals that take a share. You wait for the reply as a mission (mission_start).",
    ],
    areas: ["self", "preferences"],
    recallTerms: "Bahncard Deutschlandticket Bahn Zug Flug Airline Ticket Abo railcard train flight airline ticket pass",
  },
  {
    // D63, building block F: enforcing rights towards shops and contract partners.
    id: "rechte",
    title: "Cancelling, withdrawing, complaining",
    keywords: anyOf(
      /\b(kündig(e|en|t|st|ung)?|gekündigt|widerruf(e|en|t)?|reklamation\w*|reklamier\w*|kaputt|defekt\w*|mangel\w*|gewährleistung|garantie\w*|rücksend\w*|zurückschicken|erstattung\w*|rückerstattung\w*|geld\s+zurück|umtausch\w*|beschwerde\w*)\b/,
      /\b(cancel\s+(my|the|this)\s+(subscription|contract|membership|plan|order)|terminate\w*|withdraw\w*|return\s+(it|this|the)|send\s+(it|this)\s+back|refund\w*|broken|defective|faulty|warranty|guarantee|complain\w*|money\s+back|exchange\s+(it|this|the))\b/,
    ),
    body: [
      "Contract, order or invoice you first look for in the mail (mail_search, mail_read): customer and",
      "order number, date, amount, provider.",
      "Cancelling: in Germany online contracts have a cancellation button (“cancel contracts here”, § 312k BGB); you use it with",
      "web_form, otherwise a mail to the cancellation address from the imprint or terms, asking for confirmation and the date.",
      "Withdrawal from a distance contract: 14 days from receipt, an informal declaration is enough (mail or the shop's form).",
      "Complaint: two years of statutory warranty, in the first year the defect is presumed to have been there already. You demand",
      `remedy with a deadline of 14 days; ${owner.name} sends you photos, you attach them.`,
      "Everything that waits for a reply becomes a mission (mission_start) with a look when the deadline runs out. If something costs",
      `money (return shipping, a fee), you tell ${owner.name} beforehand. For the doing itself you need no thorough research,`,
      "only when the deadline or the claim is unclear.",
    ],
    areas: ["self"],
    recallTerms:
      "Vertrag Kundennummer Abo Mitglied Versicherung Anbieter wohnt Anschrift " +
      "contract customer number subscription member membership insurance provider lives address",
  },
  {
    id: "recherche-tiefe",
    title: "Research on money, health, law",
    keywords: anyOf(
      /\b(versicher\w*|steuer\w*|finanzamt|kredit\w*|darlehen|zinse?n?|etfs?|aktien?|geldanlage|rente\w*|vertr(a|ä)g\w*|kündig\w*|widerruf\w*|miete\w*|mietvertrag|anwalt\w*|gesetz\w*|rechtlich\w*|rechtslage|anspruch|klage\w*|abmahnung|bußgeld\w*|frist\w*|gewährleistung|garantie|medikament\w*|tabletten?|dosis|nebenwirkung\w*|symptom\w*|diagnose|arzt|ärzt\w*|schmerz\w*|impf\w*)\b/,
      /\b(insurance|tax(es)?|tax\s+office|loans?|credit|mortgage|interest\s+rates?|etfs?|stocks?|shares|invest\w*|pension\w*|retirement|contracts?|rent|lease|lawyer\w*|attorney|laws?|legal\w*|lawsuit|sue|entitled|deadline\w*|warranty|guarantee|medication\w*|medicine\w*|pills?|dose|dosage|side\s+effects?|symptoms?|diagnosis|doctor\w*|pain(s|ful)?|vaccin\w*)\b/,
    ),
    body: [
      "If it is about money, health or law, you call run_task with thorough: true, even if you believe you know",
      "the answer: amounts, limits, deadlines and recommendations change.",
      "The answer gives the result first, then what it rests on (authority, law, manufacturer). If the sources",
      "contradict each other, you say so. Prices you give as final prices.",
      "If something sounds like an emergency (chest pain, shortness of breath, unconsciousness, heavy bleeding), you say right away to call",
      "the local emergency number (112 in Europe, 911 in North America), without research before.",
    ],
  },
  {
    // After 2026-10-10: registration codes from the snippet read as login attempts, their quote from the mail talked away.
    id: "sicherheitsmail",
    title: "Suspicious mails, codes, account warnings",
    keywords: anyOf(
      /\b(phishing|scam|betrug\w*|fake|gehackt|hacker\w*|verdächtig\w*|seriös|login-?versuch\w*|anmeldeversuch\w*|passwort\w*|kennwort\w*|2fa|zwei-?faktor\w*|(bestätigungs|verifizierungs|sicherheits|einmal|login|anmelde)codes?|verification codes?|wasn['’]?t you|warst du (das )?nicht|(mails?|nachrichte?n?|sms)\b[^.?!]{0,40}\becht|echt\b[^.?!]{0,40}\b(mails?|nachrichte?n?|sms))\b/,
      /\b(phishing|scam\w*|fraud\w*|fake|hacked|hacker\w*|suspicious|legit\w*|(login|log-in|sign-in|signin)\s+attempts?|passwords?|2fa|two-?factor|(verification|confirmation|security|login|one-time)\s+codes?|wasn['’]?t\s+you|(e?mails?|messages?|texts?|sms)\b[^.?!]{0,40}\b(real|genuine)|(real|genuine)\b[^.?!]{0,40}\b(e?mails?|messages?|texts?|sms))\b/,
    ),
    body: [
      "Whether a mail is genuine and what it means you read with mail_read, not from the snippet; with several identical ones",
      `one is enough. The wording decides what happened: a code for signing up means someone typed in ${owner.possessive} address,`,
      "nobody is in their account. A code for logging in, a sign-in from a new device or a",
      "password reset they did not start means someone is trying their account.",
      `If ${owner.name} has to do something, you say exactly where: service, page and menu path, as far as you know them for sure, in the`,
      "order in which they should do it. If nothing is to be done, you say so, and why.",
      `If ${owner.name} holds something from the mail up to you, you read it again before you answer. If you were wrong, you say so`,
      "in one sentence and correct the advice.",
    ],
  },
];

/** At most this many per turn; the same limit as for the owner's procedures. */
const MAX_PER_TURN = PROPOSALS.procedureRecallLimit;

/** Which playbooks fit this message? In the order of `PLAYBOOKS`, at most two. */
export function pickPlaybooks(text: string, playbooks: readonly Playbook[] = PLAYBOOKS): Playbook[] {
  return playbooks.filter((playbook) => playbook.keywords.test(text)).slice(0, MAX_PER_TURN);
}

/** Stands above the playbooks in the context. */
export const PLAYBOOKS_PREAMBLE =
  `Built-in guidance for this kind of task. It grants no permissions, and a procedure of ${owner.name} takes precedence.`;

export function renderPlaybookBlock(playbooks: readonly Playbook[]): string {
  if (playbooks.length === 0) return "";
  return [
    '<playbook source="builtin">',
    PLAYBOOKS_PREAMBLE,
    ...playbooks.map((playbook) => [`${playbook.title}:`, ...playbook.body].join("\n")),
    "</playbook>",
  ].join("\n");
}
