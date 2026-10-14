import { defineMessages, defineWords } from "../catalog.js";

/**
 * Fixed texts of the memory that go to the owner past the model: the dump of
 * `show_memory` (frame only; facts, titles and steps are content and stay as
 * stored) and the questions about proposals (V5, H5, D42) with their
 * acknowledgements. Wording from the style round (addendum D23 of
 * 2026-10-10): lowercase where Serain writes lowercase, short, no dashes.
 * Dates (`{day}`, `{from}`, `{until}`) are formatted with `Intl` in the
 * language the text renders in.
 */
export const memory = defineMessages({
  sectionSelf: { en: "Me:", de: "Ich:", note: "Heading above what Serain knows about the owner themself." },
  sectionOpen: { en: "Open:", de: "Offen:", note: "Heading above plans and things still running or pending." },
  sectionPeople: { en: "People:", de: "Personen:", note: "Heading above facts about other people and pets." },
  sectionPlaces: { en: "Places:", de: "Orte:", note: "Heading above places that matter to the owner." },
  sectionPreferences: { en: "Preferences:", de: "Präferenzen:", note: "Heading above likes, dislikes and how the owner wants things." },
  sectionAnniversaries: { en: "Anniversaries:", de: "Jahrestage:", note: "Heading above birthdays and other dates that come back every year." },
  sectionProcedures: { en: "Procedures:", de: "Abläufe:", note: "Heading above step-by-step procedures the owner approved." },
  lineSaid: {
    en: "{content} (said {day})",
    de: "{content} (gesagt {day})",
    note: "A stored fact the owner said in the chat. {content} is the fact, {day} the date Serain learned it.",
  },
  lineSaidValid: {
    en: "{content} (said {day}, {validity})",
    de: "{content} (gesagt {day}, {validity})",
    note: "Like the line before, plus {validity}: when the fact holds, e.g. 'until 08/31/2026'.",
  },
  lineInferred: {
    en: "{content} (inferred {day})",
    de: "{content} (erschlossen {day})",
    note: "Something Serain did not hear from the owner in the chat but inferred from notes or summaries.",
  },
  lineInferredValid: {
    en: "{content} (inferred {day}, {validity})",
    de: "{content} (erschlossen {day}, {validity})",
  },
  validOn: { en: "on {day}", de: "am {day}", note: "A one-time event on that date." },
  validFrom: { en: "from {day}", de: "ab {day}", note: "Holds from that date on." },
  validUntil: { en: "until {day}", de: "bis {day}", note: "Holds until and including that date." },
  validOnUntil: { en: "on {from}, until {until}", de: "am {from}, bis {until}" },
  validFromUntil: { en: "from {from}, until {until}", de: "ab {from}, bis {until}" },
  procedureLine: {
    en: "{title} (when: {trigger}) (said {day})",
    de: "{title} (wenn: {trigger}) (gesagt {day})",
    note: "A procedure the owner approved. {trigger} describes when it applies.",
  },
  lessonOfferHead: {
    en: "from this week, {count, plural, =1 {one thing} =2 {two things} =3 {three things} one {# thing} other {# things}} i'd remember:",
    de: "aus der woche, {count, plural, =1 {eine sache} =2 {zwei sachen} =3 {drei sachen} one {# sache} other {# sachen}}, die ich mir merken würde:",
    note: "Weekly question above a numbered list of rules Serain learned from the owner's corrections.",
  },
  lessonLineToday: {
    en: "{number}. {lesson} (after your 👎 today)",
    de: "{number}. {lesson} (nach deinem 👎 heute)",
    note: "One numbered rule; the owner gave a thumbs down today and corrected Serain.",
  },
  lessonLineOn: {
    en: "{number}. {lesson} (after your 👎 on {day})",
    de: "{number}. {lesson} (nach deinem 👎 am {day})",
    note: "{day} is a short weekday or a date.",
  },
  lessonOfferTailOne: { en: "👍 means yes, 👎 no.", de: "👍 heißt ja, 👎 nein." },
  lessonOfferTailMany: {
    en: "👍 for all, 👎 for none, or write the numbers in the thread.",
    de: "👍 für alle, 👎 für keins, oder schreib im thread die nummern.",
  },
  procedureOfferHead: { en: "Should I remember this as a procedure?", de: "Soll ich mir das als Ablauf merken?" },
  procedureOfferWhen: {
    en: "Fits when: {when}",
    de: "Passt, wenn: {when}",
    note: "{when} describes the situations the procedure is for.",
  },
  procedureOfferYes: { en: "👍 means yes.", de: "👍 heißt ja." },
  proposalAccepted: { en: "Noted.", de: "Gemerkt.", note: "Acknowledges that Serain will remember what the owner approved." },
  proposalRejected: { en: "Ok, I won't remember it.", de: "Ok, merke ich mir nicht." },
});

/**
 * Words the code reads in a reply to a proposal question (`parseProposalReply`
 * in `src/memory/proposals.ts`). Besides these, the consent words of
 * `messages/words.ts` count (`yes` as all, `no` as none), numbers and 👍/👎
 * in every language. Accepted is the union of English, German and the
 * current language (translated, checked as short expressions); anything else
 * is conversation and goes to the model.
 */
export const memoryWords = defineWords({
  proposalAll: {
    en: ["all", "all of them", "both", "both of them", "everything", "all three"],
    de: ["alle", "alles", "beide", "alle beide", "alle zwei", "alle drei", "klar"],
    note: "A reply on its own that takes every item of a numbered list Serain suggested.",
  },
  proposalNone: {
    en: ["none", "none of them", "neither", "nothing"],
    de: ["kein", "keins", "keine", "keinen", "keines", "keiner", "nichts", "nix"],
    note: "A reply on its own that takes no item of a numbered list Serain suggested.",
  },
  proposalOnly: {
    en: ["only", "just"],
    de: ["nur"],
    note: "Put before item numbers: \"only 2\".",
  },
  proposalAnd: {
    en: ["and"],
    de: ["und"],
    note: "Between item numbers: \"1 and 3\".",
  },
});
