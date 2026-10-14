import { defineMessages } from "../catalog.js";

/**
 * Fixed texts of the executor that reach the owner past the model: fallback
 * names of files Serain sends from a task. Everything else the executor writes
 * goes to Serain and is English (prompts, tool results) or in the owner's
 * language because the executor was told so (report, picks).
 */
export const executor = defineMessages({
  documentName: {
    en: "document",
    de: "Dokument",
    note: "File name of a PDF from a web page whose address has no usable name. One word, no extension.",
  },
  website: {
    en: "website",
    de: "Webseite",
    note: "Stands for a web page whose host is unknown, in a screenshot's file name and caption.",
  },
});
