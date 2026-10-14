import { currentLanguage } from "../i18n/language.js";

/**
 * Did the owner name this event for deletion in their own message (addendum
 * D8 of 2026-10-13, e.g. "lösch das doppelte sommerfest", "delete the
 * duplicate summer party")? Then `calendar_delete` runs without a preview.
 * Proven by code, never by the model:
 *
 * - **No guests.** A cancellation to others cannot be taken back, the preview
 *   stays. `run` checks `has_guests` against the real event.
 * - **Only English and German** (`lang`, and every letter of the message from
 *   those languages): the word lists below exist for them alone. In any other
 *   language a negation would go unseen, so there is always the preview
 *   (fail closed).
 * - **A clear instruction:** a delete word in their words ("lösch", "entferne",
 *   "streich", "delete", "remove"), no negation or reservation ("nicht",
 *   "kein", "außer", "not", "never", "don't", "won't", "except", "keep", "if"),
 *   no question (a question mark, or a clause that starts like one: "should i
 *   delete …", "soll ich … löschen"). Whoever only asks about the event has
 *   not named it for deletion. "Absagen"/"cancel" does not count (may mean a
 *   call to the dentist), "weg" and "raus" neither ("bin auf dem weg zum sport").
 * - **A word from the title**, at least four characters, not a common word,
 *   as one piece from up to three consecutive words of the owner, none of them
 *   a filler that stands in every message ("bitte", "nochmal", "please"):
 *   "sommer fest" proves "SommerFest-Planung", an ending of up to two letters
 *   may be attached (typos "sommer festt", "planungen"), "…termin" or
 *   "…appointment" at the end drops ("zahnarzttermin"). `run` checks
 *   `current_title` against the real event, so the real title is what proves it.
 *
 * The worst case: an event without guests whose title the owner named in a
 * message with a delete word is gone. That is accepted: such an event they
 * can enter again themselves if need be. Returns the proving word, else null.
 */
export function ownerNamedEvent(event: { current_title: string; has_guests: boolean }, ownerWords: string, lang: string = currentLanguage()): string | null {
  if (event.has_guests) return null;
  if (!WORD_LISTS.includes(lang)) return null;
  // Question marks of Latin, Spanish, Greek, Arabic and CJK script.
  if (/[?¿\u037e؟？]/u.test(ownerWords)) return null;
  const words = wordsOf(ownerWords);
  if (words.some((word) => !EN_DE_LETTERS.test(word))) return null;
  if (!words.some((word) => DELETE_WORD.test(word)) || words.some((word) => RESERVATION.has(word))) return null;
  if (clausesOf(ownerWords).some((clause) => QUESTION_START.has(clause[0] ?? ""))) return null;
  const tokens = wordsOf(event.current_title).filter((token) => token.length >= 4 && !GENERIC_TITLE_WORDS.has(token) && !FILLER_WORDS.has(token));
  for (let start = 0; start < words.length; start++) {
    let joined = "";
    for (const word of words.slice(start, start + 3)) {
      if (FILLER_WORDS.has(word) || DELETE_WORD.test(word)) break;
      joined += word;
      const stem = joined.replace(/(termine?|appointments?|appt)$/, "");
      const hit = tokens.find((token) => [joined, stem].some((candidate) => candidate.startsWith(token) && candidate.length - token.length <= 2));
      if (hit) return hit;
    }
  }
  return null;
}

/** Languages with built-in word lists. Everything else: always the preview. */
const WORD_LISTS: readonly string[] = ["en", "de"];

/** Letters of English and German. A word with any other letter belongs to a language without lists. */
const EN_DE_LETTERS = /^[a-z0-9äöüß]+$/;

// NFC, so that "lösch" from two characters (o plus diaeresis) is the same word as from one.
// Apostrophes go first: "don't" is "dont", "won't" is "wont".
const wordsOf = (text: string): string[] =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’`´ʼ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The message cut at sentence and clause marks, each as its words. */
const clausesOf = (text: string): string[][] => text.split(/[.,!:\n]+/).map(wordsOf).filter((clause) => clause.length > 0);

const DELETE_WORD = /^(lösch(e|en|st|t)?|entfern(e|en|st|t)?|streich(e|en|st|t)?|delete|deletes|remove|removes)$/;

/** Negations and reservations, anywhere in the message: then it is not a clear instruction. */
const RESERVATION = new Set(
  (
    // German
    "nicht nich net kein keine keinen keinem keiner keines nie niemals nimmer lieber doch außer ausser ausgenommen " +
    "behalt behalte behalten lass lasse lassen statt anstatt sondern wenn falls ob vielleicht eventuell evtl " +
    // English (contractions without the apostrophe, see `wordsOf`)
    "not no never none nothing neither nor without dont doesnt didnt wont wouldnt shouldnt cant cannot couldnt " +
    "mustnt isnt arent wasnt werent havent hasnt hadnt neednt aint except excluding keep instead rather " +
    "if unless whether maybe perhaps"
  ).split(" "),
);

/** First words of a clause that make it a question even without a question mark. */
const QUESTION_START = new Set(
  (
    "soll sollte sollen sollst solltest wann warum wieso weshalb was wie welche welcher welches wo wer ist sind hast " +
    "hab habe hat war wäre würde würdest " +
    "should shall do does did is are was were has have had will would when why what how which where who"
  ).split(" "),
);

/** Words that stand in almost every message: an unrelated event with this title would otherwise always be named. */
const FILLER_WORDS = new Set(
  (
    "bitte danke kannst könntest kannste magst mach mache machen nimm schmeiß schmeiss hast habe haben bist sind wird " +
    "werden wurde noch nochmal einmal mal auch aber oder dann denn doch schon jetzt gleich einfach eben halt also " +
    "einen einem einer eines diese dieser diesen dieses dies jenen alle allen alles beide beiden dass weil wenn " +
    "mein meine meinen meinem meiner dein deine deinen ihre ihren sein seine seinen unser unsere euer eure " +
    "von vom zum zur über unter nach bei mit ohne gegen durch für fuer " +
    "please thanks could would also just again then that this these those from with your mine have will there " +
    "their them they what both some into onto about"
  ).split(" "),
);

/** Words that stand in many titles and name no event on their own. */
const GENERIC_TITLE_WORDS = new Set(
  (
    "termin termine eintrag kalender meeting call calls treffen event events doppelt doppelte doppelten " +
    "heute morgen woche wochen montag dienstag mittwoch donnerstag freitag samstag sonntag " +
    "lösch lösche löschen entfernen streichen " +
    "appointment appointments appt entry calendar double duplicate duplicated today tomorrow week weeks " +
    "monday tuesday wednesday thursday friday saturday sunday delete remove"
  ).split(" "),
);
