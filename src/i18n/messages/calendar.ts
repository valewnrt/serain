import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the calendar that go to the owner past the model: the way
 * back under a delete preview (W4) and the offer from the mail above its
 * preview (addendum D62 of 2026-10-10, style round). Titles, places and
 * times are placeholders and stay verbatim.
 */
export const calendar = defineMessages({
  nameIcloud: { en: "your iCloud calendar", de: "dein iCloud-Kalender", note: "The owner's calendar, named in a preview." },
  nameGoogle: { en: "your Google Calendar", de: "dein Google Kalender", note: "The owner's calendar, named in a preview." },
  nameAny: { en: "your calendar", de: "dein Kalender", note: "The owner's calendar, named in a preview." },
  deleteUndoIcloud: {
    en: "If need be, you can restore an earlier state of the calendar on icloud.com under data recovery.",
    de: "Zur Not holst du auf icloud.com unter Datenwiederherstellung einen früheren Stand des Kalenders.",
    note: "Last line under the preview of deleting an event from iCloud. 'data recovery' is the name of the page on icloud.com.",
  },
  deleteUndoGoogle: {
    en: "It then stays in the Google Calendar trash for 30 days.",
    de: "Er liegt dann noch 30 Tage im Papierkorb von Google Kalender.",
    note: "Last line under the preview of deleting an event from Google Calendar. 'it' is the event.",
  },

  // --- calendar_offer: Serain's sentence above the preview (D62) --------------
  offerTrain: {
    en: "your train booking isn't in the calendar yet, add it? 👍",
    de: "deine bahnbuchung steht noch nicht im kalender, rein damit? 👍",
  },
  offerTrainFor: {
    en: "your train booking for {when} isn't in the calendar yet, add it? 👍",
    de: "deine bahnbuchung für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerFlight: {
    en: "your flight isn't in the calendar yet, add it? 👍",
    de: "dein flug steht noch nicht im kalender, rein damit? 👍",
  },
  offerFlightFor: {
    en: "your flight for {when} isn't in the calendar yet, add it? 👍",
    de: "dein flug für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerHotel: {
    en: "your hotel isn't in the calendar yet, add it? 👍",
    de: "dein hotel steht noch nicht im kalender, rein damit? 👍",
  },
  offerHotelFor: {
    en: "your hotel for {when} isn't in the calendar yet, add it? 👍",
    de: "dein hotel für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerCar: {
    en: "your rental car isn't in the calendar yet, add it? 👍",
    de: "dein mietwagen steht noch nicht im kalender, rein damit? 👍",
  },
  offerCarFor: {
    en: "your rental car for {when} isn't in the calendar yet, add it? 👍",
    de: "dein mietwagen für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerTable: {
    en: "your table reservation isn't in the calendar yet, add it? 👍",
    de: "deine tischreservierung steht noch nicht im kalender, rein damit? 👍",
  },
  offerTableFor: {
    en: "your table reservation for {when} isn't in the calendar yet, add it? 👍",
    de: "deine tischreservierung für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerTicket: {
    en: "your ticket isn't in the calendar yet, add it? 👍",
    de: "dein ticket steht noch nicht im kalender, rein damit? 👍",
  },
  offerTicketFor: {
    en: "your ticket for {when} isn't in the calendar yet, add it? 👍",
    de: "dein ticket für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerAppointment: {
    en: "your appointment isn't in the calendar yet, add it? 👍",
    de: "dein termin steht noch nicht im kalender, rein damit? 👍",
  },
  offerAppointmentFor: {
    en: "your appointment for {when} isn't in the calendar yet, add it? 👍",
    de: "dein termin für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerDelivery: {
    en: "your delivery isn't in the calendar yet, add it? 👍",
    de: "deine lieferung steht noch nicht im kalender, rein damit? 👍",
  },
  offerDeliveryFor: {
    en: "your delivery for {when} isn't in the calendar yet, add it? 👍",
    de: "deine lieferung für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  offerBooking: {
    en: "your booking isn't in the calendar yet, add it? 👍",
    de: "deine buchung steht noch nicht im kalender, rein damit? 👍",
  },
  offerBookingFor: {
    en: "your booking for {when} isn't in the calendar yet, add it? 👍",
    de: "deine buchung für {when} steht noch nicht im kalender, rein damit? 👍",
    note: "{when} is 'today', 'tomorrow', a weekday or a date.",
  },
  whenToday: { en: "today", de: "heute" },
  whenTomorrow: { en: "tomorrow", de: "morgen" },
  whenDate: {
    en: "{date}",
    de: "den {date}",
    note: "A date without weekday, after 'for' in the offer sentence.",
  },

  // --- times in the calendar_offer preview ---------------------------------------
  spanSameDay: {
    en: "{day}, {from} to {to}",
    de: "{day}, {from} bis {to}",
    note: "{day} is a short weekday and date, {from} and {to} are clock times.",
  },
  spanTwoDays: {
    en: "{day}, {from} to {endDay}, {to}",
    de: "{day}, {from} bis {endDay}, {to}",
  },
  allDayOne: {
    en: "{day}, all day",
    de: "{day}, ganztägig",
  },
  allDayMany: {
    en: "{day} to {endDay}, all day",
    de: "{day} bis {endDay}, ganztägig",
  },
  checkinTomorrow: {
    en: "remember to check in, your flight leaves tomorrow at {time}.",
    de: "denk an den check-in, dein flug geht morgen um {time}.",
    note: "A reminder sent the day before a flight.",
  },
  checkinOn: {
    en: "remember to check in, your flight leaves on {day} at {time}.",
    de: "denk an den check-in, dein flug geht {day} um {time}.",
    note: "A reminder before a flight. {day} is a short weekday and date.",
  },
});
