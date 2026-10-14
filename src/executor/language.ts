import { owner } from "../config/owner.js";
import { currentLanguage } from "../i18n/language.js";

/**
 * The owner's language for the executor. The chat model sees the owner's
 * messages and answers in their language; the executor never sees the chat,
 * yet what it writes reaches the owner (the report through Serain, picks
 * verbatim). So every executor prompt carries the rule once
 * (`EXECUTOR_LANGUAGE_RULE`), and every task names the language at its start
 * (`ownerLanguageLine`), so a switch applies from the next task on.
 */

/** A language by its English name ("Turkish"); the code itself if `Intl` does not know it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The language the owner writes in right now, built when a task starts, never at load time. */
export function ownerLanguageLine(lang: string = currentLanguage()): string {
  return `${owner.name}'s language: ${languageName(lang)} (${lang}).`;
}

/** Once per executor prompt: what goes to the owner is written in their language. */
export const EXECUTOR_LANGUAGE_RULE =
  `Write everything meant for ${owner.name} (the report, in picks the note, detail and why, asides) in ${owner.name}'s ` +
  "language, as named with the task. Names of dishes, products and places stay as the source writes them.";
