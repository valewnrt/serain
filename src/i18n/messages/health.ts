import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of Serain's own health that go to the owner past the model
 * (style round, addendum D23 of 2026-10-10): outages and recoveries of a
 * mailbox, a calendar or a login (`src/health/integrations.ts`), the expiry of
 * a connection (D51), Serain being back after an outage
 * (`src/health/heartbeat.ts`) and the audit log self-test
 * (`src/health/audit-selftest.ts`). Lowercase like Serain writes.
 *
 * `{name}` is how the owner calls the thing: a provider id as it is ("gmx",
 * "icloud") or one of the `name…` texts below. It stands at the start of the
 * sentence.
 */
export const health = defineMessages({
  // --- what is down --------------------------------------------------------------
  nameOwnMailbox: { en: "my mailbox", de: "mein postfach", note: "Serain's own mailbox, as Serain calls it." },
  nameGmail: { en: "gmail", de: "gmail" },
  nameGoogleCalendar: { en: "google calendar", de: "google kalender" },
  nameCalendar: { en: "the calendar", de: "der kalender" },
  nameSetup: {
    en: "the login {id}",
    de: "der zugang {id}",
    note: "A stored login that could not be opened at start. {id} is its name, e.g. 'gmx'.",
  },

  // --- the login is rejected ---------------------------------------------------
  downAuthMailPassword: {
    en: "{name} hasn't let me in for {minutes} min, the password is rejected. until you reconnect it, i won't see new mails there.",
    de: "{name} lässt mich seit {minutes} min nicht rein, das passwort wird abgelehnt. bis du's neu verbindest, seh ich dort keine neuen mails.",
  },
  downAuthMailGrant: {
    en: "{name} hasn't let me in for {minutes} min, the approval is rejected. until you reconnect it, i won't see new mails there.",
    de: "{name} lässt mich seit {minutes} min nicht rein, die freigabe wird abgelehnt. bis du's neu verbindest, seh ich dort keine neuen mails.",
  },
  downAuthCalendarPassword: {
    en: "{name} hasn't let me in for {minutes} min, the password is rejected. until you reconnect it, i won't see any events there.",
    de: "{name} lässt mich seit {minutes} min nicht rein, das passwort wird abgelehnt. bis du's neu verbindest, seh ich dort keine termine.",
  },
  downAuthCalendarGrant: {
    en: "{name} hasn't let me in for {minutes} min, the approval is rejected. until you reconnect it, i won't see any events there.",
    de: "{name} lässt mich seit {minutes} min nicht rein, die freigabe wird abgelehnt. bis du's neu verbindest, seh ich dort keine termine.",
  },
  downAuthSetup: {
    en: "{name} hasn't let me in for {minutes} min, the login is rejected. until you reconnect it, i don't have it at all.",
    de: "{name} lässt mich seit {minutes} min nicht rein, die anmeldung wird abgelehnt. bis du's neu verbindest, fehlt er mir ganz.",
  },

  // --- not reachable -------------------------------------------------------------
  downMail: {
    en: "{name} hasn't worked for {minutes} min. until it works again, i won't see new mails there.",
    de: "{name} geht seit {minutes} min nicht. bis es wieder geht, seh ich dort keine neuen mails.",
  },
  downCalendar: {
    en: "{name} hasn't worked for {minutes} min. until it works again, i won't see any events there.",
    de: "{name} geht seit {minutes} min nicht. bis es wieder geht, seh ich dort keine termine.",
  },
  downSetup: {
    en: "{name} hasn't worked for {minutes} min. until it works again, i don't have it at all.",
    de: "{name} geht seit {minutes} min nicht. bis es wieder geht, fehlt er mir ganz.",
  },
  up: {
    en: "{name} works again.",
    de: "{name} geht wieder.",
  },

  // --- a connection expires (D51) -----------------------------------------------
  expiredGrant: {
    en: "the approval for {name} has expired. reconnecting takes a minute: {where}.",
    de: "die freigabe für {name} ist abgelaufen. neu verbinden dauert eine minute: {where}.",
  },
  expiredBank: {
    en: "the bank approval has expired. reconnecting takes a minute: {where}.",
    de: "die bankfreigabe ist abgelaufen. neu verbinden dauert eine minute: {where}.",
  },
  expiringGrant: {
    en: "the approval for {name} expires on {day}. renewing takes a minute: {where}.",
    de: "die freigabe für {name} läuft {day} aus. erneuern dauert eine minute: {where}.",
    note: "{day} is a short weekday and date.",
  },
  expiringBank: {
    en: "the bank approval expires on {day}. renewing takes a minute: {where}.",
    de: "die bankfreigabe läuft {day} aus. erneuern dauert eine minute: {where}.",
    note: "{day} is a short weekday and date.",
  },
  whereHost: {
    en: "{host}, under connections",
    de: "{host}, unter verbindungen",
    note: "{host} is the address of Serain's web interface; 'connections' is the name of its tab.",
  },
  whereWeb: {
    en: "in the web interface under connections",
    de: "im webinterface unter verbindungen",
    note: "'connections' is the name of a tab in Serain's web interface.",
  },

  // --- Serain itself -------------------------------------------------------------
  resolved: {
    en: "was unreachable for {minutes} min, back now.",
    de: "war {minutes} min nicht erreichbar, jetzt wieder da.",
  },
  selftestAlert: {
    en: "My audit log failed its self-test: {reasons}. Until that is sorted out, my log is not reliable.",
    de: "Mein Audit-Log hat den Selbsttest nicht bestanden: {reasons}. Bis das geklärt ist, ist mein Protokoll nicht verlässlich.",
  },
  selftestWrittenNotFound: { en: "a test entry did not arrive", de: "ein Testeintrag kam nicht an" },
  selftestUpdateAllowed: { en: "entries can be changed afterwards", de: "Einträge lassen sich nachträglich ändern" },
  selftestDeleteAllowed: { en: "entries can be deleted", de: "Einträge lassen sich löschen" },
  selftestProbeError: { en: "i couldn't check the log", de: "ich konnte das Log nicht prüfen" },
});
