import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the core (runtime, greeting, budget, reminders, recovery)
 * that go to the owner past the model, plus the names of public holidays.
 * Wording from the style round (addendum D23 of 2026-10-08 and 2026-10-10):
 * lowercase where Serain writes lowercase, short, like a friend. Content (site,
 * task, reminder text, amounts) is always a placeholder.
 */
export const core = defineMessages({
  hello: {
    en: "hi. i'm serain. just text me what you need. \"serain {stop}\" stops me anytime.",
    de: "hi. ich bin serain. schreib einfach, was du brauchst. „serain {stop}“ hält mich jederzeit an.",
    note: "Serain's very first message to its owner, sent once. \"serain {stop}\" is the emergency stop command, keep it as is.",
  },
  codeRequest: {
    en: "The login at {site} wants a code (SMS or app). Just send it to me, I'll enter it right away. I'll wait {minutes, plural, one {# minute} other {# minutes}}.",
    de: "Die Anmeldung bei {site} will einen Code (SMS oder App). Schick ihn mir einfach, ich trag ihn direkt ein. Ich warte {minutes, plural, one {# Minute} other {# Minuten}}.",
    note: "{site} is a website Serain is logging in to for the owner. The code is a one-time login code.",
  },
  codeLateAt: {
    en: "The code came too late, the login at {site} was already cancelled. Just ask me again.",
    de: "Der Code kam zu spät, die Anmeldung bei {site} ist schon abgebrochen. Frag mich einfach noch mal.",
    note: "{site} is a website.",
  },
  codeLate: {
    en: "The code came too late, the login was already cancelled. Just ask me again.",
    de: "Der Code kam zu spät, die Anmeldung ist schon abgebrochen. Frag mich einfach noch mal.",
  },
  codeEntered: {
    en: "Code is entered.",
    de: "Code ist eingetragen.",
    note: "Acknowledges a one-time login code the owner sent.",
  },
  deniedAck: {
    en: "Ok, I'll leave it.",
    de: "Ok, lasse ich.",
    note: "Reply to the owner declining an action Serain asked about.",
  },
  taskReportStuckAt: {
    en: "I checked at {site}, but writing it up is stuck right now.",
    de: "Bei {site} hab ich nachgesehen, aber beim Aufschreiben hakt es gerade.",
    note: "{site} is a website Serain looked something up on.",
  },
  taskReportStuck: {
    en: "The research is done, but writing it up is stuck right now.",
    de: "Die Recherche ist durch, aber beim Aufschreiben hakt es gerade.",
  },
  taskNothingAt: {
    en: "I got nothing out of {site}.",
    de: "Bei {site} hab ich nichts rausbekommen.",
    note: "{site} is a website.",
  },
  taskNothing: {
    en: "The research came back without a result.",
    de: "Die Recherche ist ohne Ergebnis zurückgekommen.",
  },
  taskInterruptedSession: {
    en: "the session at {site} was cut off by a restart. write \"again\" if you still want it.",
    de: "die sitzung bei {site} ist bei einem neustart abgebrochen. schreib „nochmal“, wenn du sie noch willst.",
    note: "{site} is a website. \"again\" is just a suggestion what to reply, translate it.",
  },
  taskInterruptedResearch: {
    en: "the research on \"{task}\" was cut off by a restart. write \"again\" if you still want it.",
    de: "die recherche zu „{task}“ ist bei einem neustart abgebrochen. schreib „nochmal“, wenn du sie noch willst.",
    note: "{task} quotes what the owner asked for. \"again\" is just a suggestion what to reply, translate it.",
  },
  turnRetry: {
    en: "stuck right now, i'll try again in {minutes} min.",
    de: "hakt grad, ich probier's in {minutes} min nochmal.",
  },
  turnFailed: {
    en: "stuck right now, i can't get through.",
    de: "hakt grad, ich komm nicht durch.",
  },
  budgetTurn: {
    en: "My API budget for this month is used up. It works again from the first.",
    de: "Mein API-Budget für diesen Monat ist durch. Ab dem Ersten geht es wieder.",
  },
  budgetExhaustedAll: {
    en: "api budget for the month is used up ({spent}). until the first, nothing that costs money works, not even the chat.",
    de: "api-budget für den monat ist durch ({spent}). bis zum ersten geht nichts mehr, was geld kostet, auch der chat nicht.",
    note: "{spent} is an amount of money. \"the first\" is the first day of next month.",
  },
  budgetExhaustedChat: {
    en: "api budget for the month is used up ({spent}). until the first only the chat runs, on the subscription, tasks don't work.",
    de: "api-budget für den monat ist durch ({spent}). bis zum ersten läuft nur noch der chat übers abo, aufträge gehen nicht.",
    note: "{spent} is an amount of money. \"the first\" is the first day of next month.",
  },
  budgetThrottle: {
    en: "{percent} of the api budget is gone ({spent} of {cap}). until the first i'm saving: smaller fallback model, no morning look, nothing on my own.",
    de: "{percent} vom api-budget sind weg ({spent} von {cap}). bis zum ersten spar ich: kleineres ersatzmodell, kein morgenblick, nichts von mir aus.",
    note: "{percent} is a percentage, {spent} and {cap} amounts of money. \"morning look\" is Serain's morning overview message.",
  },
  reminderLateToday: {
    en: "(was due at {time})",
    de: "(sollte um {time} kommen)",
    note: "Under a reminder that arrives late. {time} is a clock time today.",
  },
  reminderLateYesterday: {
    en: "(was due yesterday at {time})",
    de: "(sollte gestern um {time} kommen)",
    note: "Under a reminder that arrives late. {time} is a clock time.",
  },
  reminderLateDay: {
    en: "(was due {day} at {time})",
    de: "(sollte {day} um {time} kommen)",
    note: "Under a reminder that arrives late. {day} is a short weekday and date, {time} a clock time.",
  },
  linkDropped: {
    en: "[link left out]",
    de: "[Link weggelassen]",
    note: "Stands in a message where a link was removed because nothing proved it safe.",
  },
  holidayNewYear: { en: "New Year's Day", de: "Neujahr", note: "Public holiday in Germany." },
  holidayGoodFriday: { en: "Good Friday", de: "Karfreitag", note: "Public holiday in Germany." },
  holidayEasterMonday: { en: "Easter Monday", de: "Ostermontag", note: "Public holiday in Germany." },
  holidayLabourDay: { en: "Labour Day", de: "Tag der Arbeit", note: "Public holiday in Germany, May 1." },
  holidayAscension: { en: "Ascension Day", de: "Christi Himmelfahrt", note: "Public holiday in Germany." },
  holidayWhitMonday: { en: "Whit Monday", de: "Pfingstmontag", note: "Public holiday in Germany." },
  holidayGermanUnity: { en: "German Unity Day", de: "Tag der Deutschen Einheit", note: "Public holiday in Germany, October 3." },
  holidayChristmas: { en: "Christmas Day", de: "Erster Weihnachtstag", note: "Public holiday in Germany, December 25." },
  holidaySecondChristmas: { en: "Second Day of Christmas", de: "Zweiter Weihnachtstag", note: "Public holiday in Germany, December 26." },
  holidayReformation: { en: "Reformation Day", de: "Reformationstag", note: "Public holiday in parts of Germany, October 31." },
  holidayEpiphany: { en: "Epiphany", de: "Heilige Drei Könige", note: "Public holiday in parts of Germany, January 6." },
  holidayWomensDay: { en: "International Women's Day", de: "Internationaler Frauentag", note: "Public holiday in parts of Germany, March 8." },
  holidayLiberation: { en: "Liberation Day", de: "Tag der Befreiung", note: "One-off public holiday in Berlin, May 8 (end of World War II)." },
  holidayCorpusChristi: { en: "Corpus Christi", de: "Fronleichnam", note: "Public holiday in parts of Germany." },
  holidayUprising: {
    en: "Anniversary of the East German Uprising",
    de: "Jahrestag des Volksaufstands in der DDR",
    note: "One-off public holiday in Berlin, June 17 (uprising of 1953).",
  },
  holidayAssumption: { en: "Assumption Day", de: "Mariä Himmelfahrt", note: "Public holiday in parts of Germany, August 15." },
  holidayChildrensDay: { en: "World Children's Day", de: "Weltkindertag", note: "Public holiday in Thuringia, September 20." },
  holidayAllSaints: { en: "All Saints' Day", de: "Allerheiligen", note: "Public holiday in parts of Germany, November 1." },
  holidayRepentance: { en: "Day of Repentance and Prayer", de: "Buß- und Bettag", note: "Public holiday in Saxony." },
});
