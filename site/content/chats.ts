import { esc } from "./html.js";
import type { L, Lang } from "./site.js";

/**
 * The conversations on serain.si, played in a drawn iPhone (site/client/main.ts).
 * They are illustrations with the invented owner Alex, but what Serain says
 * follows the real catalog: previews ask in the words of `src/i18n/messages`,
 * the tapbacks are those of `src/channel/signals.ts`, a mail preview names the
 * recipient and shows the whole text.
 */

type Event =
  | { me: L }
  | { them: L; note?: L }
  | { voice: string }
  | { stamp: L }
  /** A tapback on the n-th message of the conversation (stamps do not count), by Serain or by the owner. */
  | { tap: string; on: number; by: "serain" | "me" };

export interface Chat {
  id: string;
  events: readonly Event[];
}

export const HERO: Chat = {
  id: "cleanup",
  events: [
    { stamp: { en: "Today 8:12", de: "Heute 8:12" } },
    { me: { en: "can you get rid of the newsletters from this week", de: "kannst du die newsletter von dieser woche loswerden" } },
    {
      them: {
        en: "Should I unsubscribe you from Shoe Outlet, Weekly Deals and City Events and move the 14 mails of the last 7 days to the trash?",
        de: "Soll ich dich bei Shoe Outlet, Weekly Deals und City Events abmelden und die 14 Mails der letzten 7 Tage in den Papierkorb legen?",
      },
      note: { en: "You can get the trash back, but not the unsubscribing.", de: "Den Papierkorb kannst du zurückholen, die Abmeldung nicht." },
    },
    { tap: "👍", on: 1, by: "me" },
    { tap: "✅", on: 0, by: "serain" },
    { me: { en: "and remind me tomorrow at 8 to call the landlord", de: "und erinner mich morgen um 8, den vermieter anzurufen" } },
    { tap: "⏰", on: 2, by: "serain" },
  ],
};

export const CHAPTER_CHATS: readonly Chat[] = [
  {
    id: "mail",
    events: [
      { stamp: { en: "Thursday 9:30", de: "Donnerstag 9:30" } },
      {
        them: {
          en: "Berg Property still hasn't answered your mail from Tuesday about the heating.",
          de: "Die Hausverwaltung Berg hat auf deine Mail von Dienstag wegen der Heizung noch nicht geantwortet.",
        },
      },
      { me: { en: "send them a short reminder", de: "schick ihnen eine kurze erinnerung" } },
      {
        them: {
          en: "Mail to Berg Property\nSubject: Heating\n\nHi, just following up on my mail from Tuesday about the heating. Could someone take a look this week? Thanks, Alex\n\nSend it like this?",
          de: "Mail an Hausverwaltung Berg\nBetreff: Heizung\n\nHallo, ich wollte kurz an meine Mail von Dienstag wegen der Heizung erinnern. Könnte diese Woche jemand vorbeischauen? Danke, Alex\n\nSoll die so raus?",
        },
        note: { en: "I can't get it back after that.", de: "Zurückholen kann ich sie danach nicht." },
      },
      { tap: "👍", on: 2, by: "me" },
      { tap: "✅", on: 1, by: "serain" },
    ],
  },
  {
    id: "calendar",
    events: [
      { me: { en: "when am I free on thursday for two hours", de: "wann hab ich donnerstag zwei stunden frei" } },
      { them: { en: "Thursday 9 to 12, or any time after 3.", de: "Donnerstag von 9 bis 12 oder ab 15 Uhr." } },
      { me: { en: "block 9 to 11 for the tax return", de: "blockier 9 bis 11 für die steuer" } },
      { tap: "✅", on: 2, by: "serain" },
    ],
  },
  {
    id: "watch",
    events: [
      { stamp: { en: "Sunday 21:04", de: "Sonntag 21:04" } },
      { me: { en: "is my 7:04 to munich tomorrow on time?", de: "ist mein zug morgen um 7:04 nach münchen pünktlich?" } },
      { them: { en: "Right now, yes. I'll keep an eye on it.", de: "Stand jetzt ja. Ich behalt ihn im Blick." } },
      { tap: "👀", on: 0, by: "serain" },
      { stamp: { en: "Monday 6:12", de: "Montag 6:12" } },
      { them: { en: "Your 7:04 is 20 minutes late and leaves from platform 9.", de: "Dein Zug um 7:04 hat 20 Minuten Verspätung und fährt von Gleis 9." } },
      { tap: "👍", on: 2, by: "me" },
    ],
  },
  {
    id: "memory",
    events: [
      { me: { en: "remember that I don't eat fish", de: "merk dir, dass ich keinen fisch esse" } },
      { tap: "👍", on: 0, by: "serain" },
      { stamp: { en: "Friday 17:40", de: "Freitag 17:40" } },
      { me: { en: "find us a table for four tonight near the office", de: "such uns heute abend einen tisch für vier beim büro" } },
      {
        them: {
          en: "Trattoria Sole, 8 minutes from the office, plenty without fish. 19:30 is free. Should I book it for 4?",
          de: "Trattoria Sole, 8 Minuten vom Büro, viel ohne Fisch. 19:30 ist frei. Soll ich für 4 reservieren?",
        },
      },
      { tap: "👍", on: 2, by: "me" },
    ],
  },
  {
    id: "voice",
    events: [
      { voice: "0:07" },
      {
        them: {
          en: "Got it. Lena's birthday is on the 12th, I'll remind you on the 10th about a present.",
          de: "Hab's. Lenas Geburtstag ist am 12., ich erinner dich am 10. an ein Geschenk.",
        },
      },
      { tap: "⏰", on: 0, by: "serain" },
    ],
  },
];

export const KILL: Chat = {
  id: "kill",
  events: [
    { me: { en: "serain stop", de: "serain stopp" } },
    {
      // `killEngaged` in src/i18n/messages/security.ts, with the resume word of each language.
      them: { en: "stopped. i'm not doing anything until you write \"serain resume\".", de: "gestoppt. ich mach nichts mehr, bis du „serain weiter“ schreibst." },
    },
  ],
};


/**
 * What each security level looks like in the chat (site/content/render.ts):
 * a read runs and answers, a reversible write just happens, anything
 * irreversible shows its preview first (the wording of `src/i18n/messages/tools.ts`).
 * `money` has no conversation; the page shows what it never offers instead.
 */
export const LEVEL_CHATS: readonly [Chat, Chat, Chat] = [
  {
    id: "level-read",
    events: [
      { me: { en: "what's on tomorrow?", de: "was steht morgen an?" } },
      { them: { en: "Dentist at 9, then free until 3.", de: "Zahnarzt um 9, dann frei bis 15 Uhr." } },
    ],
  },
  {
    id: "level-write",
    events: [
      { me: { en: "block 9 to 11 for the tax return", de: "blockier 9 bis 11 für die steuer" } },
      { tap: "✅", on: 0, by: "serain" },
    ],
  },
  {
    id: "level-irreversible",
    events: [
      {
        them: {
          en: "Mail to Lena\n\nRunning 10 minutes late, sorry!\n\nSend it like this?",
          de: "Mail an Lena\n\nBin 10 Minuten später da, sorry!\n\nSoll die so raus?",
        },
      },
      { tap: "👍", on: 0, by: "me" },
    ],
  },
];

const REACTED: Record<"serain" | "me", L> = {
  serain: { en: "Serain reacted with", de: "Serain hat reagiert mit" },
  me: { en: "You reacted with", de: "Du hast reagiert mit" },
};
const VOICE: L = { en: "Voice message", de: "Sprachnachricht" };
/** What iOS writes under the last message sent, while it is the last one in the conversation. */
const DELIVERED: L = { en: "Delivered", de: "Zugestellt" };

/** Waveform of the voice message: fixed heights, so the page is the same on every build. */
const WAVE = [3, 5, 8, 6, 10, 14, 9, 12, 7, 15, 11, 6, 9, 13, 8, 5, 10, 7, 4, 8, 6, 3];

/**
 * The thread of one conversation. Each step carries `data-step` (order) and
 * `data-wait` (pause before it, ms); without script every step is visible.
 */
export function thread(chat: Chat, lang: Lang, attrs = ""): string {
  const taps = new Map<number, string[]>();
  let step = 0;
  const pause = (event: Event) => ("tap" in event ? 450 : "stamp" in event ? 300 : "them" in event ? 500 : 700);
  const items: Array<{ html: (taps: string) => string; message: boolean }> = [];
  for (const event of chat.events) {
    const attr = `data-step="${step++}" data-wait="${pause(event)}"`;
    if ("tap" in event) {
      const label = `${REACTED[event.by][lang]} ${event.tap}`;
      const list = taps.get(event.on) ?? [];
      list.push(`<span class="tap by-${event.by}" ${attr} role="img" aria-label="${esc(label)}">${event.tap}</span>`);
      taps.set(event.on, list);
      continue;
    }
    if ("stamp" in event) {
      // iOS sets the day in bold and the time regular.
      const text = event.stamp[lang];
      const cut = text.lastIndexOf(" ");
      items.push({ message: false, html: () => `<li class="stamp" ${attr}><b>${esc(text.slice(0, cut))}</b> ${esc(text.slice(cut + 1))}</li>` });
      continue;
    }
    const receipt = `<span class="receipt" aria-hidden="true">${DELIVERED[lang]}</span>`;
    if ("me" in event) {
      items.push({ message: true, html: (t) => `<li class="msg me" ${attr}><p class="bubble">${esc(event.me[lang])}</p>${t}${receipt}</li>` });
    } else if ("voice" in event) {
      const bars = WAVE.map((h) => `<i class="h${h}"></i>`).join("");
      items.push({
        message: true,
        html: (t) => `<li class="msg me" ${attr}><p class="bubble voice" aria-label="${esc(`${VOICE[lang]}, ${event.voice}`)}"><span class="play" aria-hidden="true"></span><span class="wave" aria-hidden="true">${bars}</span><span class="len">${event.voice}</span></p>${t}${receipt}</li>`,
      });
    } else {
      const note = event.note ? `<span class="note">${esc(event.note[lang])}</span>` : "";
      items.push({
        message: true,
        html: (t) => `<li class="msg them" ${attr}><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><p class="bubble">${esc(event.them[lang])}${note}</p>${t}</li>`,
      });
    }
  }
  let n = 0;
  const body = items.map((item) => (item.message ? item.html((taps.get(n++) ?? []).join("")) : item.html(""))).join("");
  return `<ol class="thread" data-thread ${attrs}>${body}</ol>`;
}

/**
 * The iPhone 16 Pro frame: one SVG over the screen, drawn in the frame's own
 * units (427 × 881, the screen is 390 × 844 at 18/18). The frame is masked
 * out over the screen so the conversation shows through; the Dynamic Island
 * and its lenses sit on top of it. Ids carry the phone's name, since a page
 * has more than one.
 */
function frame(id: string): string {
  const f = (n: number) => `${id}-f${n}`;
  const blur = (n: number, x: number, y: number, w: number, h: number, d: number) =>
    `<filter id="${f(n)}" x="${x}" y="${y}" width="${w}" height="${h}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="bg"/><feBlend mode="normal" in="SourceGraphic" in2="bg" result="shape"/><feGaussianBlur stdDeviation="${d}"/></filter>`;
  const glint = (n: number, d: string, fill: string, opacity = "") => `<g${opacity ? ` opacity="${opacity}"` : ""} filter="url(#${f(n)})"><path d="${d}" fill="${fill}"/></g>`;
  const band = (x: number, y: number, w: number, h: number) => `<g class="band"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#7C7C7C"/></g>`;
  return `<svg class="phone-frame" viewBox="0 0 427 881" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <mask id="${id}-screen"><rect width="427" height="881" fill="white"/><rect x="18" y="18" width="390" height="844" rx="55" fill="black"/></mask>
    ${blur(0, -0.167, 0.167, 427, 880.667, 0.5)}
    ${blur(1, 6.332, 6.334, 414, 868, 0.333333)}
    ${blur(2, 244.143, 44.096, 6.191, 11.143, 0.929)}
    ${blur(3, 244.762, 45.81, 4.953, 7.714, 0.929)}
    ${blur(4, 245.808, 45.784, 3.867, 6.883, 0.619)}
    ${blur(5, 250.332, 44.096, 6.191, 11.143, 0.929)}
    ${blur(6, 250.951, 45.81, 4.953, 7.714, 0.929)}
    ${blur(7, 250.991, 45.784, 3.867, 6.883, 0.619)}
    ${blur(8, 169.666, 42.647, 7.8, 14.04, 1.17)}
    ${blur(9, 170.446, 44.807, 6.24, 9.72, 1.17)}
    ${blur(10, 171.276, 45.555, 3.311, 7.112, 0.39)}
    ${blur(11, 161.865, 42.647, 7.8, 14.04, 1.17)}
    ${blur(12, 162.645, 44.807, 6.24, 9.72, 1.17)}
    ${blur(13, 164.744, 45.555, 3.311, 7.112, 0.39)}
    <clipPath id="${id}-body"><rect width="426.667" height="880.667" rx="70" fill="white"/></clipPath>
  </defs>
  <g clip-path="url(#${id}-body)">
    <g mask="url(#${id}-screen)">
      <rect width="426.667" height="880.667" rx="70" fill="black"/>
      <rect x="3.833" y="3.834" width="419" height="873" rx="66.167" stroke="#454548" stroke-width="4.333"/>
      <rect x="0.833" y="0.833" width="425" height="879" rx="69.167" stroke="#37373a" stroke-width="1.667"/>
      <g opacity="0.9" filter="url(#${f(0)})"><rect x="1.666" y="2" width="423.333" height="877" rx="68.667" stroke="#454548" stroke-width="1.667"/></g>
      <g opacity="0.8" filter="url(#${f(1)})"><rect x="7.333" y="7.334" width="412" height="866" rx="62.667" stroke="#646464" stroke-width="0.667"/></g>
    </g>
    <rect x="151.666" y="31.667" width="123.333" height="36" rx="18" fill="black"/>
    <g opacity="0.75">
      <rect x="242" y="41.334" width="16.667" height="16.667" rx="8.333" fill="#121212"/>
      <rect x="242" y="41.334" width="16.667" height="16.667" rx="8.333" stroke="#0E0E0E" stroke-width="0.667"/>
      ${glint(2, "M248.476 45.953C245.66 46.778 244.722 51.524 248.476 53.381C247.538 50.905 247.538 48.635 248.476 45.953Z", "#50A99A")}
      ${glint(3, "M247.857 47.667C246.449 48.111 245.98 50.667 247.857 51.667C247.388 50.334 247.388 49.111 247.857 47.667Z", "#50A99A")}
      ${glint(4, "M248.436 47.022C247.23 47.204 246.348 50.542 247.805 51.429C247.289 50.238 247.547 47.857 248.436 47.022Z", "#D0FFF7", "0.4")}
      ${glint(5, "M252.19 45.953C255.006 46.778 255.944 51.524 252.19 53.381C253.128 50.905 253.128 48.635 252.19 45.953Z", "#3E518C")}
      ${glint(6, "M252.809 47.667C254.217 48.111 254.686 50.667 252.809 51.667C253.278 50.334 253.278 49.111 252.809 47.667Z", "#26408D")}
      ${glint(7, "M252.23 47.022C253.437 47.204 254.318 50.542 252.861 51.429C253.377 50.238 253.119 47.857 252.23 47.022Z", "#0D308C", "0.5")}
    </g>
    <g opacity="0.4">
      <rect width="24" height="24" rx="12" transform="matrix(-1 0 0 1 181.666 37.667)" fill="#141414"/>
      <rect width="15.6" height="15.6" rx="7.8" transform="matrix(-1 0 0 1 177.466 41.867)" fill="black"/>
      ${glint(8, "M172.006 44.987C175.554 46.027 176.736 52.007 172.006 54.347C173.189 51.227 173.189 48.367 172.006 44.987Z", "#50A99A")}
      ${glint(9, "M172.786 47.147C174.56 47.707 175.151 50.927 172.786 52.187C173.377 50.507 173.377 48.967 172.786 47.147Z", "#50A99A")}
      ${glint(10, "M172.056 46.334C173.576 46.563 174.687 50.77 172.851 51.887C173.501 50.387 173.176 47.387 172.056 46.334Z", "#D0FFF7", "0.5")}
      ${glint(11, "M167.325 44.987C163.777 46.027 162.595 52.007 167.325 54.347C166.143 51.227 166.143 48.367 167.325 44.987Z", "#3E518C")}
      ${glint(12, "M166.545 47.147C164.771 47.707 164.18 50.927 166.545 52.187C165.954 50.507 165.954 48.967 166.545 47.147Z", "#26408D")}
      ${glint(13, "M167.275 46.334C165.755 46.563 164.644 50.77 166.48 51.887C165.83 50.387 166.155 47.387 167.275 46.334Z", "#0D308C", "0.5")}
    </g>
    <g opacity="0.4">
      ${band(-0.001, 786, 6, 5.333)}${band(87.666, 874, 5.333, 6)}${band(420.666, 89, 6, 5.333)}
      ${band(-0.001, 89, 6, 5.333)}${band(339.666, 0, 5.333, 6)}${band(420.666, 785.667, 6, 5.333)}
    </g>
  </g>
</svg>`;
}

/** The status bar of iOS: time left of the island, signal, Wi-Fi and battery right of it. */
const STATUS = `<div class="ios-status" aria-hidden="true"><span class="ios-time">9:41</span><span></span><span class="ios-icons"><svg viewBox="0 0 18 12"><rect x="0" y="7.5" width="3" height="4.5" rx="0.9"/><rect x="5" y="5" width="3" height="7" rx="0.9"/><rect x="10" y="2.5" width="3" height="9.5" rx="0.9"/><rect x="15" y="0" width="3" height="12" rx="0.9"/></svg><svg viewBox="0 0 16 12"><path d="M8 2.4c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8 .7C5.2.7 2.7 1.8.8 3.6L2 4.8a8.5 8.5 0 0 1 6-2.4Z"/><path d="M8 5.8c1.4 0 2.6.5 3.6 1.4l1.2-1.2A6.8 6.8 0 0 0 8 4.1 6.8 6.8 0 0 0 3.2 6l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Z"/><path d="M8 9.2c.5 0 .9.2 1.2.5L8 11 6.8 9.7c.3-.3.7-.5 1.2-.5Z"/></svg><svg viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity="0.35"/><rect x="2" y="2" width="20" height="9" rx="2.5"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" opacity="0.4"/></svg></span></div>`;

const CHEVRON_LEFT = `<svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_RIGHT = `<svg viewBox="0 0 8 12"><path d="m2 1.5 4.5 4.5L2 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const VIDEO = `<svg viewBox="0 0 26 18"><rect x="1" y="2" width="16" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="m18.5 7.2 5.2-3.3c.6-.4 1.3 0 1.3.7v8.8c0 .7-.7 1.1-1.3.7l-5.2-3.3Z" fill="currentColor"/></svg>`;
const PLUS = `<svg viewBox="0 0 16 16"><path d="M8 1.5v13M1.5 8h13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const MIC = `<svg viewBox="0 0 14 20"><rect x="3.5" y="1" width="7" height="12" rx="3.5" fill="currentColor"/><path d="M1 9.5a6 6 0 0 0 12 0M7 15.5V19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

/**
 * A drawn iPhone with the Messages app of iOS 26 around one or more
 * conversations; with several, the active one shows (`.scene.active`).
 */
export function phone(threads: readonly string[], id: string, extraClass = ""): string {
  const scenes =
    threads.length === 1 ? threads[0]! : threads.map((t, i) => `<div class="scene${i === 0 ? " active" : ""}">${t}</div>`).join("");
  return `<div class="phone ${extraClass}">
  <div class="phone-screen">
    <div class="phone-body">${scenes}</div>
    <div class="ios-top" aria-hidden="true">
      ${STATUS}
      <div class="ios-nav"><span class="ios-glass ios-round">${CHEVRON_LEFT}</span><span class="ios-contact"><span class="avatar">S</span><span class="ios-glass ios-name">Serain${CHEVRON_RIGHT}</span></span><span class="ios-glass ios-round">${VIDEO}</span></div>
    </div>
    <div class="ios-bottom" aria-hidden="true"><span class="ios-glass ios-round ios-plus">${PLUS}</span><span class="ios-glass ios-field"><span>iMessage</span>${MIC}</span></div>
    <span class="ios-home" aria-hidden="true"></span>
  </div>
  ${frame(id)}
</div>`;
}
