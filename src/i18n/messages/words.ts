import { defineWords } from "../catalog.js";

/**
 * Words the code reads from the owner, outside the model (D8.2, D8.3). The
 * first entry of each list is the one fixed texts show ("serain resume",
 * "yes always"). Accepted is always the union of English, German and the
 * current language (`src/i18n/words.ts`); other languages come translated
 * from these lists and are checked to be short plain expressions.
 *
 * Changing a list changes what counts as consent: that is a security change
 * (D8), reviewed like one.
 */
export const words = defineWords({
  yes: {
    en: ["yes", "yep", "yeah", "yup", "ok", "okay", "sure", "go ahead", "do it"],
    de: ["ja", "jo", "jep", "jap", "ok", "okay", "mach", "passt"],
    note: "A reply on its own that approves an action Serain asked about.",
  },
  no: {
    en: ["no", "nope", "nah", "stop", "don't", "cancel", "leave it"],
    de: ["nein", "ne", "nee", "nö", "stopp", "stop", "lass", "lass es"],
    note: "A reply on its own that declines an action Serain asked about.",
  },
  always: {
    en: ["always"],
    de: ["immer"],
    note: "Said right after a yes word (\"yes always\"): approve this and every later one of the same kind.",
  },
  stop: {
    en: ["stop"],
    de: ["stopp"],
    note: "Emergency stop word, typed after the assistant's name: \"serain stop\".",
  },
  resume: {
    en: ["resume"],
    de: ["weiter"],
    note: "Typed after the assistant's name to lift the emergency stop: \"serain resume\". One word, not a stop word.",
  },
  revoke: {
    en: ["revoke"],
    de: ["widerruf"],
    note: "Typed after the assistant's name to withdraw all standing approvals: \"serain revoke\". One word.",
  },
});
