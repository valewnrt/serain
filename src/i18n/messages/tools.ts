import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the tools that go to the owner past the model: the previews
 * of the confirmation protocol (D8.3, D14), their way back (W4), what a
 * standing approval covers (`src/agent/tools/grants.ts`) and the few file
 * names the owner sees. The owner approves exactly what these previews say,
 * so content (recipients, mail text, subjects, titles, sites, field values) is
 * always a placeholder and stays verbatim in every language. Wording from the
 * style round; the German is unchanged from before.
 */
export const tools = defineMessages({
  // Mail (`mail_send`, `mail_send_each`, cleanup).
  mailTo: {
    en: "Mail to {to}",
    de: "Mail an {to}",
    note: "First line of a mail preview. {to} is a list of mail addresses.",
  },
  mailToAs: {
    en: "Mail to {to}, as {from}",
    de: "Mail an {to}, als {from}",
    note: "First line of a mail preview sent from the assistant's own mailbox. {from} is a sender like 'Serain <hi@example.com>'.",
  },
  mailToFrom: {
    en: "Mail to {to}, from {from}",
    de: "Mail an {to}, von {from}",
    note: "First line of a mail preview sent from another of the owner's mailboxes. {from} is a mail address.",
  },
  mailCc: {
    en: "Cc: {cc}",
    de: "Cc: {cc}",
  },
  mailSubject: {
    en: "Subject: {subject}",
    de: "Betreff: {subject}",
  },
  mailAttachment: {
    en: "Attachment: {name} ({size})",
    de: "Anhang: {name} ({size})",
    note: "{name} is a file name, {size} a file size like '1.2 MB'.",
  },
  mailAsk: {
    en: "Send it like this?",
    de: "Soll die so raus?",
    note: "Last line of a mail preview, below the full mail text.",
  },
  mailUndo: {
    en: "I can't get it back after that.",
    de: "Zurückholen kann ich sie danach nicht.",
    note: "Under a mail preview: a sent mail cannot be recalled.",
  },
  mailLaterFiles: {
    en: "With an attachment this only works right away, I only keep the file until my next restart. \"{yes}\" or \"{no}\".",
    de: "Mit Anhang geht das nur sofort, die Datei liegt nur bis zum nächsten Neustart bei mir. „{yes}“ oder „{no}“.",
    note: "Reply when the owner approves a mail with an attachment for later. {yes} and {no} are the words that approve or decline.",
  },
  mailBatchHead: {
    en: "{count, plural, one {# mail} other {# mails}}, each on its own:",
    de: "{count, plural, one {# Mail} other {# Mails}}, jede einzeln:",
    note: "Above a list of mails that go out one by one.",
  },
  mailBatchHeadAs: {
    en: "{count, plural, one {# mail} other {# mails}}, each on its own, as {from}:",
    de: "{count, plural, one {# Mail} other {# Mails}}, jede einzeln, als {from}:",
    note: "Like the line before, sent from the assistant's own mailbox. {from} is a sender like 'Serain <hi@example.com>'.",
  },
  mailBatchHeadFrom: {
    en: "{count, plural, one {# mail} other {# mails}}, each on its own, from {from}:",
    de: "{count, plural, one {# Mail} other {# Mails}}, jede einzeln, von {from}:",
    note: "Like the line before, sent from another of the owner's mailboxes. {from} is a mail address.",
  },
  mailBatchAsk: {
    en: "Send them like this?",
    de: "Sollen die so raus?",
  },
  mailBatchUndo: {
    en: "I can't get them back after that.",
    de: "Zurückholen kann ich sie danach nicht.",
  },
  mailbox: {
    en: "Mailbox: {address}",
    de: "Postfach: {address}",
  },
  spamFolderUndo: {
    en: "You can get the trash back until the provider empties it.",
    de: "Den Papierkorb kannst du zurückholen, bis der Anbieter ihn leert.",
    note: "Under the preview for emptying the spam folder into the trash.",
  },

  // What a standing approval covers: last line of a preview ("... covers {scope} from then on") and the revoke receipt.
  grantMailTo: {
    en: "mails to {to}",
    de: "Mails an {to}",
    note: "What a standing approval covers. {to} is one mail address.",
  },
  grantMailToAsSerain: {
    en: "mails as Serain to {to}",
    de: "Mails als Serain an {to}",
    note: "What a standing approval covers: mails from the assistant's own mailbox. Serain is the assistant's name. {to} is one mail address.",
  },
  grantSelftest: {
    en: "test runs of the confirmation",
    de: "Testläufe der Bestätigung",
    note: "What a standing approval covers: harmless test runs of the approval protocol.",
  },

  // Self test of the confirmation protocol (`confirm_selftest`).
  selftestAsk: {
    en: "Shall I test the confirmation? Nothing happens except an entry in the audit log.",
    de: "Soll ich die Bestätigung testen? Es passiert nichts außer einem Eintrag im Audit-Log.",
  },
  selftestAskNote: {
    en: "Shall I test the confirmation ({note})? Nothing happens except an entry in the audit log.",
    de: "Soll ich die Bestätigung testen ({note})? Es passiert nichts außer einem Eintrag im Audit-Log.",
    note: "{note} is a short keyword for the test run.",
  },
  selftestUndo: {
    en: "Nothing to take back there.",
    de: "Zurücknehmen muss man da nichts.",
  },

  // Logged-in session (`run_site_task`).
  siteAsk: {
    en: "Shall I log in at {site} with your login from the vault and take a look?",
    de: "Soll ich mich bei {site} mit deinem Zugang aus dem Tresor anmelden und nachsehen?",
    note: "{site} is the name of a saved login, e.g. 'bahn'. The task follows on the next line.",
  },
  siteUndo: {
    en: "I only look and close the session afterwards.",
    de: "Ich schau nur nach und schließ die Sitzung danach.",
  },

  // Web forms (`web_form`, `web_submit`).
  formAskAccount: {
    en: "Shall I fill in the form in your account at {site} (with your login from the vault)?",
    de: "Soll ich das Formular in deinem Konto bei {site} (mit deinem Zugang aus dem Tresor) ausfüllen?",
    note: "{site} is the name of a saved login. The task follows on the next line.",
  },
  formAskHost: {
    en: "Shall I fill in the form on {host}?",
    de: "Soll ich das Formular auf {host} ausfüllen?",
    note: "{host} is a website like example.com. The task follows on the next line.",
  },
  formValuesLead: {
    en: "From you I'll enter:",
    de: "Von dir trag ich ein:",
    note: "Above the owner's details (name, address, ...) that will be typed into the form.",
  },
  formNoValues: {
    en: "I won't enter anything of yours.",
    de: "Von dir trag ich nichts ein.",
  },
  formUndo: {
    en: "The page already sees what I type. It's only sent after your second 👍, once you've seen the finished page.",
    de: "Was ich tippe, sieht die Seite schon. Abgeschickt wird erst nach deinem zweiten 👍, wenn du die fertige Seite gesehen hast.",
  },
  submitAskAccount: {
    en: "Shall I submit this in your account at {site}?",
    de: "Soll ich das in deinem Konto bei {site} abschicken?",
    note: "{site} is the name of a saved login. The form's fields follow below.",
  },
  submitAskAccountTitled: {
    en: "Shall I submit this in your account at {site}? \"{title}\"",
    de: "Soll ich das in deinem Konto bei {site} abschicken? „{title}“",
    note: "{site} is the name of a saved login, {title} the title of the web page.",
  },
  submitAskHost: {
    en: "Shall I submit this on {host}?",
    de: "Soll ich das auf {host} abschicken?",
    note: "{host} is a website like example.com. The form's fields follow below.",
  },
  submitAskHostTitled: {
    en: "Shall I submit this on {host}? \"{title}\"",
    de: "Soll ich das auf {host} abschicken? „{title}“",
    note: "{host} is a website like example.com, {title} the title of the web page.",
  },
  fieldUnlabeled: {
    en: "(no label)",
    de: "(ohne Beschriftung)",
    note: "Stands for a form field without a label.",
  },
  fieldChecked: {
    en: "checked",
    de: "angehakt",
    note: "Value of a ticked checkbox in a form.",
  },
  fieldSelected: {
    en: "selected",
    de: "gewählt",
    note: "Value of the chosen option of a radio button group.",
  },
  fieldPassword: {
    en: "[password, hidden]",
    de: "[Passwort, ausgeblendet]",
    note: "Value of a password field, which is never shown.",
  },
  fieldsEmpty: {
    en: "Empty:",
    de: "Leer:",
    note: "Above the labels of form fields that stay empty.",
  },
  submitButton: {
    en: "Button: \"{button}\"",
    de: "Knopf: „{button}“",
    note: "{button} is the label of the button that sends the form.",
  },
  formNoImage: {
    en: "No image: {reason}.",
    de: "Kein Bild: {reason}.",
    note: "Why there is no screenshot of the form; {reason} says why.",
  },
  formNoImageFailed: {
    en: "No image: the capture didn't work.",
    de: "Kein Bild: die Aufnahme ging nicht.",
  },
  formImageName: {
    en: "form.jpg",
    de: "formular.jpg",
    note: "File name of the screenshot of a form. Keep it short, lowercase, ending in .jpg, no spaces.",
  },
  submitUndo: {
    en: "Taking it back after that only works with the site itself.",
    de: "Zurücknehmen geht danach nur bei der Seite selbst.",
  },

  // Calendar (`calendar_create`, `calendar_offer`, `calendar_update`, `calendar_delete`).
  timeRange: {
    en: "{from} to {to}",
    de: "{from} bis {to}",
    note: "A time span; {from} and {to} are a day with a time.",
  },
  createAsk: {
    en: "Shall I add \"{title}\" and send the invitations?",
    de: "Soll ich „{title}“ eintragen und die Einladungen verschicken?",
    note: "{title} is the title of a calendar event.",
  },
  invalidTime: {
    en: "{value} (invalid, won't be created)",
    de: "{value} (ungültig, wird nicht angelegt)",
    note: "{value} is a time as given, which could not be read.",
  },
  series: {
    en: "Series: {series}",
    de: "Serie: {series}",
    note: "{series} describes a repeating event, e.g. '6 events, Mon, Wed until 10/12/2026'.",
  },
  seriesInvalid: {
    en: "Series: invalid, won't be created",
    de: "Serie: ungültig, wird nicht angelegt",
  },
  seriesLabel: {
    en: "{count, plural, one {# event} other {# events}}, {days} until {until}",
    de: "{count, plural, one {# Termin} other {# Termine}}, {days} bis {until}",
    note: "{days} lists weekdays, {until} is the last day.",
  },
  location: {
    en: "Location: {location}",
    de: "Ort: {location}",
  },
  guestsLead: {
    en: "Guests:",
    de: "Gäste:",
    note: "Before the mail addresses of invited guests.",
  },
  createUndo: {
    en: "I can delete it again, but the invitations will already be out.",
    de: "Löschen kann ich ihn wieder, die Einladungen sind dann aber schon raus.",
  },
  offerTitle: {
    en: "Event \"{title}\"",
    de: "Termin „{title}“",
    note: "First line of an offer to put a booking from a mail into the calendar.",
  },
  offerCalendar: {
    en: "Calendar: {calendar}",
    de: "Kalender: {calendar}",
    note: "{calendar} is the name of a calendar.",
  },
  offerCheckin: {
    en: "Check-in reminder: {day}, {time}",
    de: "Erinnerung an den Check-in: {day}, {time}",
    note: "A reminder to check in for a flight; {day} is a day, {time} a clock time.",
  },
  offerUndo: {
    en: "i can delete it again",
    de: "kann ich wieder löschen",
  },
  offerUndoBoth: {
    en: "i can delete both again",
    de: "kann ich beides wieder löschen",
    note: "Both: the calendar event and the check-in reminder.",
  },
  updateAsk: {
    en: "Shall I change \"{title}\"? The guests will see it.",
    de: "Soll ich „{title}“ ändern? Die Gäste kriegen das mit.",
    note: "{title} is the current title of a calendar event with guests.",
  },
  newTitle: {
    en: "New title: {title}",
    de: "Neuer Titel: {title}",
  },
  newTime: {
    en: "New time: {time}",
    de: "Neue Zeit: {time}",
  },
  newTimeInvalid: {
    en: "New time: {value} (invalid, won't be changed)",
    de: "Neue Zeit: {value} (ungültig, wird nicht geändert)",
  },
  newLocation: {
    en: "New location: {location}",
    de: "Neuer Ort: {location}",
  },
  newLocationNone: {
    en: "New location: (none)",
    de: "Neuer Ort: (keiner)",
  },
  newNote: {
    en: "New note: {note}",
    de: "Neue Notiz: {note}",
  },
  newNoteNone: {
    en: "New note: (none)",
    de: "Neue Notiz: (keine)",
  },
  updateUndo: {
    en: "Changing it back works, but then they get another mail.",
    de: "Zurückändern geht, dann kriegen sie aber noch eine Mail.",
  },
  deleteAsk: {
    en: "Shall I delete \"{title}\"?",
    de: "Soll ich „{title}“ löschen?",
  },
  deleteAskGuests: {
    en: "Shall I delete \"{title}\"? The guests get a cancellation.",
    de: "Soll ich „{title}“ löschen? Die Gäste kriegen eine Absage.",
  },
  deleteUndoGuests: {
    en: "Nobody takes the cancellation back. {undo}",
    de: "Die Absage holt keiner zurück. {undo}",
    note: "{undo} is a sentence on how the deleted event itself can be restored.",
  },
  // Background work (`run_task`, `watch_*`, `send_file`, `vault_file`).
  taskAck: {
    en: "on it",
    de: "schau ich nach",
    note: "Short acknowledgement when a background research task starts. Lowercase, no period.",
  },
  watchEveryMail: {
    en: "checking every new mail, until {end}.",
    de: "schau bei jeder neuen mail nach, bis {end}.",
    note: "Sent when a watcher starts. {end} is a day, possibly with a time, without a final period.",
  },
  watchHourly: {
    en: "checking hourly, until {end}.",
    de: "schau stündlich nach, bis {end}.",
    note: "Sent when a watcher starts. {end} is a day, possibly with a time, without a final period.",
  },
  watchEvery: {
    en: "checking every {minutes} min, until {end}.",
    de: "schau alle {minutes} min nach, bis {end}.",
    note: "Sent when a watcher starts. {end} is a day, possibly with a time, without a final period.",
  },
  screenshotName: {
    en: "Screenshot {label}",
    de: "Screenshot {label}",
    note: "File name of a screenshot, without extension. {label} names the site.",
  },
  screenshotAtSite: {
    en: "Screenshot at {label}",
    de: "Screenshot bei {label}",
    note: "Caption of a screenshot from a logged-in account. {label} is the name of the site.",
  },
  screenshotOf: {
    en: "Screenshot of {label}",
    de: "Screenshot von {label}",
    note: "Caption of a screenshot of a web page. {label} is the site.",
  },
  screenshotOfShows: {
    en: "Screenshot of {label}, shows: {shows}",
    de: "Screenshot von {label}, zeigt: {shows}",
    note: "Caption of a screenshot of a web page. {label} is the site, {shows} what is on it.",
  },
  documentPage: {
    en: "{name} page {page}",
    de: "{name} Seite {page}",
    note: "File name of one page of a PDF sent as images, without extension. {name} is the document's name.",
  },
  noteName: {
    en: "Note",
    de: "Notiz",
    note: "Default file name of a PDF note without a title, without extension.",
  },
  vaultCaption: {
    en: "from the vault",
    de: "aus dem Tresor",
    note: "Caption of a file the assistant sends from the owner's encrypted vault.",
  },
});
