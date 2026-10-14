import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the confirmation protocol (D8.3, D14) and the kill switch
 * (D8.2). Wording from the style round (addendum D23 of 2026-10-08): lowercase,
 * short, like a friend. `{yes}`, `{no}`, `{always}`, `{resume}` are the words
 * the code accepts right now (`primaryWord` in `src/i18n/words.ts`), so every
 * hint names a word that works.
 */
export const security = defineMessages({
  reissueHead: {
    en: "this one expired, here it is again:",
    de: "die ist abgelaufen, hier nochmal frisch:",
    note: "Above a confirmation preview that is sent again because the old one expired.",
  },
  expired: {
    en: "this one expired.",
    de: "die ist abgelaufen.",
    note: "Reply to an approval of a confirmation preview that expired.",
  },
  standingFor: {
    en: "\"{yes} {always}\" covers {scope} from then on.",
    de: "„{yes} {always}“ gilt ab dann für {scope}.",
    note: "Last line of a preview. {scope} is what a standing approval covers, e.g. 'mails to anna@example.com'.",
  },
  laterWhen: {
    en: "{day} at {time}",
    de: "{day} um {time}",
    note: "A point in time: {day} is a short weekday and date, {time} a clock time.",
  },
  laterScheduled: {
    en: "ok, goes out {when}. until then a \"{no}\" here in the thread is enough.",
    de: "ok, geht {when} raus. bis dahin reicht „{no}“ hier im thread.",
    note: "The owner approved an action for later. {when} is the time, {no} the word that cancels it.",
  },
  laterPastAt: {
    en: "{when} is already over. tell me a later time here, e.g. \"{example}\".",
    de: "{when} ist schon vorbei. sag mir hier eine spätere zeit, z. B. „{example}“.",
    note: "{example} is a command the owner can type, keep it as is.",
  },
  laterPast: {
    en: "that time is already over. tell me a later time here, e.g. \"{example}\".",
    de: "die zeit ist schon vorbei. sag mir hier eine spätere zeit, z. B. „{example}“.",
    note: "{example} is a command the owner can type, keep it as is.",
  },
  laterTooSoon: {
    en: "that's less than {minutes, plural, one {# minute} other {# minutes}} away. then just \"{yes}\".",
    de: "das ist in weniger als {minutes, plural, one {# minute} other {# minuten}}. dann einfach „{yes}“.",
  },
  laterTooFar: {
    en: "i don't schedule anything further out than {days, plural, one {# day} other {# days}}. say a nearer time here or \"{yes}\" for right away.",
    de: "weiter als {days, plural, one {# tag} other {# tage}} plan ich nichts ein. sag hier eine nähere zeit oder „{yes}“ für sofort.",
  },
  laterTooMany: {
    en: "there {count, plural, one {is already # thing} other {are already # things}} scheduled. cancel one first or \"{yes}\" for right away.",
    de: "es {count, plural, one {ist schon # sache} other {sind schon # sachen}} eingeplant. erst eine absagen oder „{yes}“ für sofort.",
  },
  laterNotSupported: {
    en: "this only works right away: \"{yes}\" or \"{no}\".",
    de: "das geht nur sofort: „{yes}“ oder „{no}“.",
  },
  killEngaged: {
    en: "stopped. i'm not doing anything until you write \"serain {resume}\".",
    de: "gestoppt. ich mach nichts mehr, bis du „serain {resume}“ schreibst.",
    note: "Reply to the emergency stop. \"serain {resume}\" is the command that lifts it, keep it as is.",
  },
  killNotEngaged: {
    en: "wasn't stopped.",
    de: "war gar nicht gestoppt.",
    note: "Reply to the resume command when nothing was stopped.",
  },
  killReleased: {
    en: "i'm back.",
    de: "bin wieder da.",
    note: "Reply to the resume command after an emergency stop.",
  },
  killScheduledCancelled: {
    en: "{count, plural, one {the scheduled approval is cancelled too.} other {the # scheduled approvals are cancelled too.}}",
    de: "{count, plural, one {die eingeplante freigabe ist auch abgesagt.} other {die # eingeplanten freigaben sind auch abgesagt.}}",
    note: "After the emergency stop: actions the owner had approved for later will not run.",
  },
  stoppedResearch: {
    en: "{count, plural, one {the research} other {the # research tasks}}",
    de: "{count, plural, one {die recherche} other {die # recherchen}}",
    note: "Part of a list of running tasks the emergency stop cancelled.",
  },
  stoppedSession: {
    en: "the session at {site}",
    de: "die sitzung bei {site}",
    note: "Part of a list of running tasks the emergency stop cancelled. {site} is a website.",
  },
  stoppedTasks: {
    en: "{tasks} {count, plural, one {was} other {were}} cancelled too.",
    de: "{tasks} {count, plural, one {ist} other {sind}} auch abgebrochen.",
    note: "{tasks} is a list of tasks (e.g. 'the research and the session at example.com'), {count} how many.",
  },
  revoked: {
    en: "all standing approvals are gone.",
    de: "alle dauerfreigaben sind weg.",
    note: "Reply to the command that withdraws all standing approvals.",
  },
  revokedList: {
    en: "all standing approvals are gone ({grants}).",
    de: "alle dauerfreigaben sind weg ({grants}).",
    note: "{grants} lists what they covered, e.g. 'mails to anna@example.com'.",
  },
});
