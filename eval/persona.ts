/**
 * Whom the evals play for. The cases in the repo are synthetic and tell of an
 * invented owner called Alex: facts ("Alex mag Sushi"), mails ("Hi Alex"),
 * event texts the code builds with the name ("Alex put 👎 on your message"). The system prompt and the questions to `judge` take the name from
 * `OWNER_NAME`. If an eval ran with the real owner's name, the model would see
 * two people where operation knows only one, and the eval would measure the
 * confusion instead of the model.
 *
 * So every eval command line pins the persona as its first import, before
 * `src/config/owner.ts` reads it: the name Alex, the time zone Europe/Berlin
 * (`OWNER_TIMEZONE` is required) and German as the starting language, because
 * Alex writes German in the cases. This is independent of who starts the eval:
 * runs stay comparable between instances, and personal data does not appear
 * anyway (no user model, only synthetic facts). The same persona applies in
 * `pnpm test` (vitest.config.ts).
 *
 * Exception: real samples from the owner's own mailbox (`pnpm eval:mail --cases
 * <path>`) are addressed to the real owner and run with their name, time zone
 * and language from `.dev.vars`.
 */
export const EVAL_OWNER_NAME = "Alex";

if (!process.argv.includes("--cases")) {
  process.env["OWNER_NAME"] = EVAL_OWNER_NAME;
  process.env["OWNER_TIMEZONE"] = "Europe/Berlin";
  process.env["OWNER_LANGUAGE"] = "de";
}
