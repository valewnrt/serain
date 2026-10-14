import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the mail module that go to the owner past the model, all of
 * them parts of a preview (D14): the cleanup and spam folder questions
 * (`src/mail/cleanup.ts`), the warning about a new recipient above a mail
 * (`src/mail/recipients.ts`) and the series mail (`src/mail/batch.ts`).
 * Wording from the style round (decision of 2026-10-13: names instead of
 * addresses, a question, lists with "•"). Sender names, addresses, subjects
 * and mail text are placeholders and stay verbatim.
 *
 * `{names}` is a list of senders: one name stays in the sentence, several
 * stand below each other where the placeholder is (`listSentence` in
 * `src/mail/cleanup.ts`), so keep it where the list can break the sentence.
 */
export const mail = defineMessages({
  // --- mail_cleanup preview ---------------------------------------------------
  askUnsubscribe: {
    en: "Should I unsubscribe you from {names}?",
    de: "Soll ich dich bei {names} abmelden?",
  },
  askUnsubscribeTrash: {
    en: "Should I unsubscribe you from {names} and move {count, plural, one {the one mail} other {the # mails}} of the last {days} days to the trash?",
    de: "Soll ich dich bei {names} abmelden und {count, plural, one {die eine Mail} other {die # Mails}} der letzten {days} Tage in den Papierkorb legen?",
  },
  askTrash: {
    en: "Should I move {count, plural, one {the one mail} other {the # mails}} of the last {days} days from {names} to the trash?",
    de: "Soll ich {count, plural, one {die eine Mail} other {die # Mails}} der letzten {days} Tage von {names} in den Papierkorb legen?",
  },
  askMixed: {
    en: "Should I clean up like this? Mails of the last {days} days:",
    de: "Soll ich so aufräumen? Mails der letzten {days} Tage:",
  },
  groupUnsubscribe: {
    en: "Unsubscribe: {names}",
    de: "Abmelden: {names}",
  },
  groupUnsubscribeTrash: {
    en: "Unsubscribe and {count, plural, one {# mail} other {# mails}} to the trash: {names}",
    de: "Abmelden und {count, plural, one {# Mail} other {# Mails}} in den Papierkorb: {names}",
  },
  groupNoRoute: {
    en: "Unsubscribing isn't possible: {names}",
    de: "Abmelden geht nicht: {names}",
  },
  groupNoRouteTrash: {
    en: "Unsubscribing isn't possible, only {count, plural, one {# mail} other {# mails}} to the trash: {names}",
    de: "Abmelden geht nicht, nur {count, plural, one {# Mail} other {# Mails}} in den Papierkorb: {names}",
  },
  groupDeferred: {
    en: "Not unsubscribing this time (too many unsubscribe pages at once): {names}",
    de: "Diesmal nicht abmelden (zu viele Abmeldeseiten auf einmal): {names}",
  },
  groupDeferredTrash: {
    en: "Not unsubscribing this time (too many unsubscribe pages at once), only {count, plural, one {# mail} other {# mails}} to the trash: {names}",
    de: "Diesmal nicht abmelden (zu viele Abmeldeseiten auf einmal), nur {count, plural, one {# Mail} other {# Mails}} in den Papierkorb: {names}",
  },
  groupTrash: {
    en: "Only {count, plural, one {# mail} other {# mails}} to the trash: {names}",
    de: "Nur {count, plural, one {# Mail} other {# Mails}} in den Papierkorb: {names}",
  },
  groupSpam: {
    en: "{count, plural, one {The one mail} other {All # mails}} to the spam folder from {names}",
    de: "{count, plural, one {Die eine Mail} other {Alle # Mails}} in den Spam-Ordner von {names}",
    note: "{names} are full mail addresses here.",
  },
  namesMore: {
    en: "and {count} more",
    de: "und {count} weiteren",
    note: "Last item of a list of senders: how many more there are.",
  },
  unsubscribeMailOne: {
    en: "An unsubscribe mail goes out in your name to {address}.",
    de: "Abmelde-Mail geht in deinem Namen an {address}.",
  },
  unsubscribeMailMany: {
    en: "Unsubscribe mails go out in your name to: {addresses}",
    de: "Abmelde-Mails gehen in deinem Namen an: {addresses}",
  },
  kept: {
    en: "{count, plural, one {1 sender is} other {# senders are}} on your keep list and {count, plural, one {stays} other {stay}}.",
    de: "{count, plural, one {1 Absender steht} other {# Absender stehen}} auf deiner Behalten-Liste und {count, plural, one {bleibt} other {bleiben}}.",
  },
  undoTrash: {
    en: "You can get the trash back.",
    de: "Den Papierkorb kannst du zurückholen.",
  },
  undoTrashNotUnsubscribe: {
    en: "You can get the trash back, but not the unsubscribing.",
    de: "Den Papierkorb kannst du zurückholen, die Abmeldung nicht.",
  },
  undoSpam: {
    en: "You can get trash and spam folder back.",
    de: "Papierkorb und Spam-Ordner kannst du zurückholen.",
  },
  undoSpamNotUnsubscribe: {
    en: "You can get trash and spam folder back, but not the unsubscribing.",
    de: "Papierkorb und Spam-Ordner kannst du zurückholen, die Abmeldung nicht.",
  },

  // --- mail_spam_folder preview -----------------------------------------------
  spamEmpty: {
    en: "Should I empty the spam folder? {count, plural, one {# mail} other {# mails}} to the trash.",
    de: "Soll ich den Spam-Ordner leeren? {count, plural, one {# Mail} other {# Mails}} in den Papierkorb.",
  },
  spamRescueOnly: {
    en: "Should I get this back from the spam folder?",
    de: "Soll ich das aus dem Spam-Ordner zurückholen?",
  },
  spamRescued: {
    en: "Back to the inbox: {names}",
    de: "Zurück in den Posteingang: {names}",
  },
  spamRescuedItem: {
    en: "{name} ({count, plural, one {# mail} other {# mails}})",
    de: "{name} ({count, plural, one {# Mail} other {# Mails}})",
  },
  spamMissing: {
    en: "Found nothing from {names}",
    de: "Nichts gefunden von {names}",
  },

  // --- new recipients above the mail_send preview -----------------------------
  placeMails: { en: "in your mails", de: "in deinen Mails", note: "Where an address was looked up." },
  placeContacts: { en: "in your contacts", de: "in deinen Kontakten", note: "Where an address was looked up." },
  placeChat: { en: "in our chat", de: "in unserem Chat", note: "Where an address was looked up: the owner's chat with Serain." },
  sourceMails: { en: "your mails", de: "deine Mails", note: "What could not be checked." },
  sourceContacts: { en: "your contacts", de: "deine Kontakte", note: "What could not be checked." },
  sourceChat: { en: "our chat", de: "unseren Chat", note: "What could not be checked: the owner's chat with Serain." },
  newNeverWrittenOne: {
    en: "New: you've never written to {list}, and {count, plural, one {the address doesn't appear} other {the addresses don't appear}} {place}.",
    de: "Neu: an {list} hast du noch nie geschrieben, und {count, plural, one {die Adresse kommt} other {die Adressen kommen}} {place} nicht vor.",
    note: "{list} are mail addresses, {place} is e.g. 'in your contacts'.",
  },
  newNeverWrittenTwo: {
    en: "New: you've never written to {list}, and {count, plural, one {the address appears} other {the addresses appear}} neither {place1} nor {place2}.",
    de: "Neu: an {list} hast du noch nie geschrieben, und {count, plural, one {die Adresse kommt} other {die Adressen kommen}} weder {place1} noch {place2} vor.",
  },
  newNeverWrittenThree: {
    en: "New: you've never written to {list}, and {count, plural, one {the address appears} other {the addresses appear}} neither {place1} nor {place2} nor {place3}.",
    de: "Neu: an {list} hast du noch nie geschrieben, und {count, plural, one {die Adresse kommt} other {die Adressen kommen}} weder {place1} noch {place2} noch {place3} vor.",
  },
  newUnknownOne: {
    en: "New: {list} {count, plural, one {doesn't appear} other {don't appear}} {place}.",
    de: "Neu: {list} {count, plural, one {kommt} other {kommen}} {place} nicht vor.",
  },
  newUnknownTwo: {
    en: "New: {list} {count, plural, one {appears} other {appear}} neither {place1} nor {place2}.",
    de: "Neu: {list} {count, plural, one {kommt} other {kommen}} weder {place1} noch {place2} vor.",
  },
  newUnknownThree: {
    en: "New: {list} {count, plural, one {appears} other {appear}} neither {place1} nor {place2} nor {place3}.",
    de: "Neu: {list} {count, plural, one {kommt} other {kommen}} weder {place1} noch {place2} noch {place3} vor.",
  },
  notCheckable: {
    en: "couldn't check {sources} right now.",
    de: "{sources} konnte ich gerade nicht prüfen.",
    note: "Its own sentence; the first letter is capitalised by the code. {sources} is e.g. 'your contacts'.",
  },
  unchecked: {
    en: "Couldn't check whether you've written to {list} before.",
    de: "Konnte nicht prüfen, ob du an {list} schon geschrieben hast.",
  },

  // --- mail_send_batch preview --------------------------------------------------
  batchMail: {
    en: "Mail {number} to {to}",
    de: "Mail {number} an {to}",
  },
  batchSubject: {
    en: "Subject: {subject}",
    de: "Betreff: {subject}",
  },
  batchSameText: {
    en: "Text same as mail 1.",
    de: "Text wie Mail 1.",
  },
  batchTextExcept: {
    en: "Text same as mail 1, except:",
    de: "Text wie Mail 1, außer:",
  },
  batchLine: {
    en: "Line {line}:",
    de: "Zeile {line}:",
    note: "Line number in the first mail where a difference starts.",
  },
  batchEmptyLine: {
    en: "(empty line)",
    de: "(Leerzeile)",
  },
});
