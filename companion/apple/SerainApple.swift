// Reads calendars, reminders and contacts for the Mac companion (D28).
// Read-only. Runs as its own small app bundle so that macOS assigns the
// permissions (TCC) to this program and not to node or the terminal.
//
// Usage:   serain-apple status | authorize | calendar <from> <to> | reminders [list] | contacts <query>
// Output:  exactly one JSON object on stdout.
//
// Apart from `authorize`, no command asks for a permission: a call that nobody
// at the screen expects must not open a dialog.

import Contacts
import EventKit
import Foundation

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "error": message])
}

let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone.current
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

func parseDay(_ text: String) -> Date? {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.date(from: text)
}

func eventStatus(_ type: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: type) {
    case .fullAccess: return "granted"
    case .notDetermined: return "not_determined"
    default: return "denied"
    }
}

func contactStatus() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "granted"
    case .notDetermined: return "not_determined"
    default: return "denied"
    }
}

func wait(_ seconds: Int, _ body: (@escaping () -> Void) -> Void) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    body { semaphore.signal() }
    return semaphore.wait(timeout: .now() + .seconds(seconds)) == .success
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else { fail("bad_request", "Command missing") }
let store = EKEventStore()

switch command {
case "status":
    emit(["ok": true, "calendar": eventStatus(.event), "reminders": eventStatus(.reminder), "contacts": contactStatus()])

case "authorize":
    _ = wait(120) { done in store.requestFullAccessToEvents { _, _ in done() } }
    _ = wait(120) { done in store.requestFullAccessToReminders { _, _ in done() } }
    _ = wait(120) { done in CNContactStore().requestAccess(for: .contacts) { _, _ in done() } }
    emit(["ok": true, "calendar": eventStatus(.event), "reminders": eventStatus(.reminder), "contacts": contactStatus()])

case "calendar":
    guard arguments.count == 3, let from = parseDay(arguments[1]), let lastDay = parseDay(arguments[2]) else {
        fail("bad_request", "calendar <YYYY-MM-DD> <YYYY-MM-DD>")
    }
    guard eventStatus(.event) == "granted" else { fail("not_authorized", "Calendar access is not granted") }
    guard let to = Calendar.current.date(byAdding: .day, value: 1, to: lastDay), to > from,
          to.timeIntervalSince(from) <= 32 * 86_400 else { fail("bad_request", "Invalid range or longer than 31 days") }
    let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
        .sorted { $0.startDate < $1.startDate }
    let limit = 50
    emit([
        "ok": true,
        "truncated": events.count > limit,
        "events": events.prefix(limit).map { event in
            [
                "title": event.title ?? "",
                "start": iso.string(from: event.startDate),
                "end": iso.string(from: event.endDate),
                "allDay": event.isAllDay,
                "calendar": event.calendar?.title ?? "",
                "location": event.location ?? "",
            ] as [String: Any]
        },
    ])

case "reminders":
    guard eventStatus(.reminder) == "granted" else { fail("not_authorized", "Reminders access is not granted") }
    let wanted = arguments.count > 1 ? arguments[1].lowercased() : nil
    let lists = store.calendars(for: .reminder).filter { wanted == nil || $0.title.lowercased() == wanted }
    if wanted != nil && lists.isEmpty { fail("failed", "This list does not exist") }
    var found: [EKReminder] = []
    let finished = wait(15) { done in
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
        store.fetchReminders(matching: predicate) { reminders in
            found = reminders ?? []
            done()
        }
    }
    guard finished else { fail("timeout", "Reminders did not answer") }
    let due: (EKReminder) -> Date? = { $0.dueDateComponents.flatMap { Calendar.current.date(from: $0) } }
    let sorted = found.sorted { (due($0) ?? .distantFuture) < (due($1) ?? .distantFuture) }
    let limit = 50
    emit([
        "ok": true,
        "truncated": sorted.count > limit,
        "reminders": sorted.prefix(limit).map { reminder in
            [
                "title": reminder.title ?? "",
                "due": due(reminder).map { iso.string(from: $0) } ?? NSNull(),
                "list": reminder.calendar?.title ?? "",
            ] as [String: Any]
        },
    ])

case "contacts":
    guard arguments.count == 2, arguments[1].count >= 2 else { fail("bad_request", "contacts <query>") }
    guard contactStatus() == "granted" else { fail("not_authorized", "Contacts access is not granted") }
    let keys = [
        CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey,
        CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
    ] as [CNKeyDescriptor]
    // A mail address searches the addresses, not the name: this is how Serain checks in the
    // mail_send preview whether a recipient is in the owner's contacts (addendum to D34).
    // `matchedBy` tells the server what was searched for; an older helper without the
    // field counts there as "not checkable", never as "not found".
    let byEmail = arguments[1].contains("@")
    let predicate = byEmail
        ? CNContact.predicateForContacts(matchingEmailAddress: arguments[1])
        : CNContact.predicateForContacts(matchingName: arguments[1])
    do {
        let matches = try CNContactStore().unifiedContacts(matching: predicate, keysToFetch: keys)
        let limit = 10
        emit([
            "ok": true,
            "matchedBy": byEmail ? "email" : "name",
            "truncated": matches.count > limit,
            "contacts": matches.prefix(limit).map { contact in
                [
                    "name": [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " "),
                    "organization": contact.organizationName,
                    "phones": contact.phoneNumbers.map { $0.value.stringValue },
                    "emails": contact.emailAddresses.map { $0.value as String },
                ] as [String: Any]
            },
        ])
    } catch {
        fail("failed", "Contacts not readable")
    }

default:
    fail("bad_request", "Unknown command")
}
