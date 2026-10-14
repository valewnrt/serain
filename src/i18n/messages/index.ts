import type { CatalogEntry, Message } from "../catalog.js";
import { calendar } from "./calendar.js";
import { core } from "./core.js";
import { executor } from "./executor.js";
import { forms } from "./forms.js";
import { health } from "./health.js";
import { mail } from "./mail.js";
import { media } from "./media.js";
import { memory, memoryWords } from "./memory.js";
import { security } from "./security.js";
import { tools } from "./tools.js";
import { words } from "./words.js";

/**
 * Every message module, by name. The translator works from this list (a
 * module missing here stays English in every other language), and
 * `test/i18n-catalog.test.ts` checks that every file in this folder is listed,
 * that every message has English and German, and that both have the same
 * placeholders. A new module: one file, one line here.
 */
export const MESSAGE_MODULES = {
  calendar,
  core,
  executor,
  forms,
  health,
  mail,
  media,
  memory, memoryWords,
  security,
  tools,
  words,
} as const satisfies Record<string, Record<string, Message>>;

/** The whole catalog with ids `<module>.<key>`. */
export function catalogEntries(): CatalogEntry[] {
  return Object.entries(MESSAGE_MODULES).flatMap(([module, messages]) =>
    Object.entries(messages as Record<string, Message>).map(([key, message]) => ({ id: `${module}.${key}`, message })),
  );
}
