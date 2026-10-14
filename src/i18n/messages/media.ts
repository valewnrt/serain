import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of files and media that reach the owner past the model: the
 * caption of an .ics file (`src/files/ics.ts`) and the name of a file that came
 * without one (`src/files/shelf.ts`). Dates in the captions stay as the model
 * wrote them (`YYYY-MM-DD`), they are content.
 */
export const media = defineMessages({
  icsAllDay: {
    en: "{day}, all day",
    de: "{day}, ganztägig",
    note: "Caption under a calendar file the owner can tap. {day} is a date like 2026-10-12.",
  },
  icsAllDayRange: {
    en: "{from} to {to}, all day",
    de: "{from} bis {to}, ganztägig",
    note: "Caption under a calendar file for several days. {from} and {to} are dates like 2026-10-12.",
  },
  unnamedPdf: {
    en: "document.pdf",
    de: "Dokument.pdf",
    note: "File name for a PDF that came without a name. Keep the .pdf ending, no spaces.",
  },
  unnamedFile: {
    en: "file",
    de: "Datei",
    note: "File name for a file that came without a name. One word, no spaces.",
  },
});
