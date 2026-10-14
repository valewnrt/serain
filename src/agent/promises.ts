/**
 * Promises to the owner (addendum to D33 of 2026-10-13). Serain entered an
 * event and promised to get in touch as soon as place and time came from the
 * organiser. Nothing in the system held on to that; the mail came and fell
 * through.
 *
 * The promise is recognised in Serain's own text to the owner, the way Serain
 * writes (lowercase, short), in English and German. Deliberately narrow: a hit
 * costs at most one step, because the turn still ends at the second `end_turn`
 * (`TurnState.promiseOpen`). In any other language nothing is recognised and
 * the safety net stays silent; the turn itself runs as before.
 */
const PROMISE = new RegExp(
  [
    // German. "meld mich", "melde mich", "meld ich mich", not "meld dich" or "anmelden".
    String.raw`\bmelde?\s+(?:ich\s+)?mich\b`,
    // "sag dir bescheid", "geb dir dann sofort bescheid", "sag ich dir bescheid".
    String.raw`\b(?:sage?|gebe?)\s+(?:ich\s+)?dir\b[^.?!\n]{0,40}\bbescheid\b`,
    String.raw`\bhalte?\s+(?:ich\s+)?dich\s+auf\s+dem\s+laufenden\b`,
    // "schreib dir, sobald …", "sobald sie da ist, sag ich's dir".
    String.raw`\bschreibe?\s+(?:ich\s+)?dir\b[^.?!\n]{0,40}\b(?:sobald|wenn)\b`,
    String.raw`\bsobald\b[^.?!\n]{0,60}\b(?:sag|schreib|meld)e?\s+ich\b`,
    // English. "i'll let you know", "i'll get back to you", "i'll keep you posted", not "let me know".
    String.raw`\b(?:i['’]?ll|i\s+will)\s+(?:\w+\s+)?(?:let\s+you\s+know|get\s+back\s+to\s+you|keep\s+you\s+(?:posted|updated|in\s+the\s+loop))\b`,
    // "i'll text you as soon as …", "i'll tell you once it's there".
    String.raw`\b(?:i['’]?ll|i\s+will)\s+(?:\w+\s+)?(?:tell|text|write|message|ping)\s+you\b[^.?!\n]{0,40}\b(?:as\s+soon\s+as|once|when)\b`,
    // "as soon as it's there, i'll tell you".
    String.raw`\b(?:as\s+soon\s+as|once)\b[^.?!\n]{0,60}\b(?:i['’]?ll|i\s+will)\s+(?:let\s+you\s+know|tell\s+you|text\s+you|write\s+to\s+you|message\s+you|ping\s+you)\b`,
  ].join("|"),
  "i",
);

/** Does Serain promise the owner in this text to get in touch later on its own? */
export function promisesFollowUp(text: string): boolean {
  return PROMISE.test(text);
}
