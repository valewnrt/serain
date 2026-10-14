# Languages in Serain

Serain answers in the language the owner writes in, in any language. Two
different mechanisms make that happen, and every string in the code belongs to
exactly one of them:

1. **Text that goes through the model** (system prompt, tool descriptions,
   tool results, `<context>` blocks, event texts): written in English. The
   chat and executor prompts tell the model to answer in the owner's language.
   Nothing here is translated by code.
2. **Text that goes to the owner past the model** (preview frames, kill-switch
   replies, greetings, health, budget, recovery and reminder notices, dates):
   lives in the catalog and renders through `t()`. English and German are
   built in; any other language is translated once by the model from the
   English catalog, checked line by line and cached.

Developer texts (`throw new Error`, `log.*`, audit details) are English and
stay out of the catalog.

## The API

```ts
import { t } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { mail } from "../i18n/messages/mail.js";

t(mail.sent, { to: address });            // current language
t(mail.sent, { to: address }, "en");      // a given language
new Intl.DateTimeFormat(currentLocale(), { timeZone: OWNER_TIMEZONE, ... });
```

- `currentLanguage(): string`: base language right now (`en`, `de`, `tr`).
  Synchronous. Starts at `OWNER_LANGUAGE` (`owner.language`, default `en`),
  then follows the owner's messages (`observeOwnerText`, called by the
  runtime; you never call it).
- `currentLocale(lang?)`: the tag for `Intl` (`de-AT` while the owner writes
  in the language of `OWNER_LANGUAGE=de-AT`, else the base language).
- `t(message, params?, lang?)`: renders a message. Values are inserted
  verbatim after translation, never translated and never parsed as syntax.
  Numbers get the locale's decimal sign and no grouping; format amounts,
  dates and anything else yourself and pass a string. A missing value throws:
  the TypeScript type already requires every placeholder of the English text.
- `textLanguage(message, lang?)`: the language a message will really render
  in (English until its translation is there). Use it when you format a date
  or a list around a text, so the parts match the frame:
  `const lang = textLanguage(msg); t(msg, { day: format(date, currentLocale(lang)) }, lang)`.
- Words the code reads from the owner: `src/i18n/words.ts` (below).

## Adding texts

One file per module in `src/i18n/messages/<module>.ts`, one line in
`src/i18n/messages/index.ts`:

```ts
import { defineMessages } from "../catalog.js";

export const mail = defineMessages({
  sent: {
    en: "sent to {to}.",
    de: "ist an {to} raus.",
    note: "{to} is a mail address.", // optional, for the translator; never content
  },
  left: {
    en: "{count, plural, one {# mail} other {# mails}} left.",
    de: "{count, plural, one {# mail} other {# mails}} übrig.",
  },
});
```

Rules:

- **English and German, always both**, with the same placeholders.
  `test/i18n-catalog.test.ts` fails otherwise, and also when a file in
  `messages/` is missing from `index.ts`, or when `defineMessages` is used
  anywhere else.
- **Placeholders** are `{name}`. **Plurals** are ICU-light:
  `{count, plural, =0 {…} one {…} other {…}}`, `#` is the number. `other` is
  required. No other ICU constructs, no literal braces. Avoid a placeholder
  directly after the words `zero/one/two/few/many/other` in running text
  (`the other {name}`): the type would read it as a plural branch.
- **Content is a placeholder, never part of the text**: recipients, mail
  bodies, subjects, amounts, sender names, titles, file names, values. They
  stay verbatim in every language. The translator only ever sees the fixed
  catalog (D8); a test checks that no parameter value reaches it.
- **Style**: the owner reads these as messages from a friend. Lowercase where
  Serain writes lowercase, short, no filler, no dashes (the translation check
  rejects a dash the English does not have). New fixed texts and new wording
  are a style-round decision; keep the existing German exactly as it was.
- **No sentence assembly**: do not glue translated fragments with `+` or
  `"und"`. Make the whole sentence one message, or join list items with
  `Intl.ListFormat(currentLocale(lang), { type: "conjunction" })`.
- **Dates and numbers**: `Intl` with `currentLocale()` and the time zone
  `OWNER_TIMEZONE`. No hand-made weekday arrays, no `"um " + time`, no comma
  decimals; a connecting word ("at", "um") belongs into the message.

## Translation of other languages

On the first switch to a language without a catalog, `catalog.ts` sends the
whole English catalog (with the German as a tone reference) in small batches
to the `extraction` role with structured output. Each line is checked: same
placeholders, all plural categories of the target language
(`Intl.PluralRules`), no new digits, links, markup, dashes or line breaks, a
length bound; word lists must be short plain expressions. Accepted lines are
cached in `agent_state` under `catalog:<lang>` with a hash of the English
catalog. Until then, and for every rejected line, the owner reads English. A
changed English line is translated again on the next switch or start; the
rest comes from the cache.

## Words the code reads (`words.ts`, `messages/words.ts`)

Consent in the thread of a preview (D8.3) and the codewords after "serain"
(D8.2) are read by code, never by the model:

| Kind | English | German | Used as |
|---|---|---|---|
| `yes` | yes, yep, yeah, yup, ok, okay, sure, go ahead, do it | ja, jo, jep, jap, ok, okay, mach, passt | whole reply approves |
| `no` | no, nope, nah, stop, don't, cancel, leave it | nein, ne, nee, nö, stopp, stop, lass, lass es | whole reply declines |
| `always` | always | immer | `<yes> <always>`: standing approval |
| `stop` | stop | stopp | `serain stop`: kill switch |
| `resume` | resume | weiter | `serain resume`: release |
| `revoke` | revoke | widerruf | `serain revoke`: drop standing approvals |

Safety rules (fail closed):

- Accepted is always the union of English, German and the current language.
  The current language's words come from the translated catalog after the
  line check; without them, only English and German work. 👍/👎 work in every
  language.
- A word that is both yes and no counts as no. Among codewords, stop beats
  revoke beats resume.
- Only a whole message is a decision. Anything else, in any language, is
  conversation; the model cannot approve anything.
- "Later" ("yes tomorrow at 8", "ja morgen um 8", `security/later.ts`) has
  grammars for English and German only. In other languages a time is
  conversation and nothing is scheduled.
- Fixed texts name the words with `primaryWord(kind)`, so a hint always names
  a word that works.

Changing a word list changes what counts as consent: that is a security
change, reviewed against D8.

## Adding a language

- **Texts:** nothing to do. The first switch to a new language translates the
  catalog, and the owner reads English until that is done.
- **Words the code reads:** come with the translation, checked as short plain
  expressions. English and German always stay accepted.
- **Word-based heuristics** (below): a list for the new language in that
  module, with tests. Until then the module stays fail closed for it. Review
  against D8.
- **"Later" approvals:** a grammar in `security/later.ts`; without one, a time
  in that language is conversation.
- **Spoken replies:** a local Piper voice is three entries kept in sync by
  `test/sandbox.test.ts` (`PIPER_VOICES` in `deploy/sandbox/Dockerfile.tts`,
  `VOICES` in `deploy/sandbox/helper.mjs`, `PIPER_VOICES` in
  `src/media/speech.ts`); a hosted voice is one line in `SPEECH.voices`
  (`src/config/models.ts`). Transcription needs nothing: whisper detects the
  language itself.
- **Public holidays:** `src/holidays.ts` knows Germany only (`OWNER_COUNTRY=DE`).

## Heuristics in other modules

Code that recognises the owner's language by word lists (purchase or send
detection, `namedByOwner`, negations, confidentiality) keeps built-in lists for
`en` and `de` and is **fail-closed** in every other language: always the
preview, no shortcut without one, mask rather than show. Prefer
language-neutral signals where they exist (digit patterns, emoji, HTML
attributes such as `type=submit` or `autocomplete=cc-number`, structure).
Code that reads its own texts back by regex (`/gescheitert/`, a sentinel
string, a heading in the user model) must switch to structured data (fields,
enums), never to an English regex.

## Prompt tags (binding list)

Prompt tags are English, and so are their attribute names. A new tag gets an
English name; when you rename one, rename every occurrence consistently,
including prose that mentions it ("under <events> in the <context>"), regexes
that detect it and the tests. The table lists every tag with the German name it
had before, because the wrapper in `security/untrusted.ts` still defuses the
old frame names (`fremdinhalt`, `nachtrag`) when foreign content imitates
them.

| German (old) | English (current) | Where |
|---|---|---|
| `<kontext>` | `<context>` | runtime, prompt, timeline, tools, heartbeat, playbooks, … |
| `<fremdinhalt quelle="…">` | `<untrusted source="…">` | `security/untrusted.ts` (also the `MARKER` regex that defuses look-alikes), prompt, attachments, heartbeat, morning; `FRAME_ATTACKS` in `test/fuzz/helpers.ts` |
| `<nachtrag message_id="…">` | `<addendum message_id="…">` | `agent/tools/types.ts`, registry, prompt |
| `<vorhaben>` | `<missions>` | missions, mail trigger, prompt |
| `<ablaeufe>` | `<procedures>` | `memory/procedures.ts`, prompt |
| `<vorgehen quelle="eingebaut">` | `<playbook source="builtin">` | `agent/playbooks.ts`, prompt |
| `<stoerungen>` | `<disruptions>` | prompt |
| `<gerade>` | `<current>` | `memory/recall.ts`, `config/memory.ts`, playbooks |
| `<verlauf>` | `<history>` | memory extract, context, gate |
| `<nachricht>` | `<message>` | memory extract, recall, gate |
| `<termine>` | `<events>` | prompt, `agent/tools/task.ts` |
| `<stil>` | `<style>` | prompt, style |
| `<protokoll>` | `<protocol>` | prompt |
| `<nutzermodell>` | `<user_model>` | prompt |
| `<gedaechtnis>` | `<memory>` | prompt, `memory/summaries.ts` |
| `<fakten>` | `<facts>` | memory extract, recall |
| `<fakt>` | `<fact>` | memory recall |
| `<frueher>` | `<earlier>` | memory recall |
| `<offene_rueckfrage>` | `<open_question>` | memory recall |
| `<vergessen>` | `<forget>` | memory extract |
| `<profil>` | `<profile>` | memory extract |
| `<ausschnitt>` | `<excerpt>` | memory extract |
| `<bereits_gespeichert>` | `<already_saved>` | memory extract |
| `<grundtext>` | `<base_text>` | memory extract |
| `<learned_bisher>` | `<learned_so_far>` | memory extract |
| `<neue_fakten>` | `<new_facts>` | memory extract |
| `<ersetzt>` | `<replaced>` | memory extract |
| `<abgelaufen>` | `<expired>` | memory extract |
| `<zusammenfassungen_seit_dem_letzten_lauf>` | `<summaries_since_last_run>` | memory extract |
| `<neuer_fakt>` | `<new_fact>` | memory gate |
| `<bestehende_fakten>` | `<existing_facts>` | memory gate |
| `<nachricht_des_assistenten>` | `<assistant_message>` | memory lesson |
| `<nutzer_danach>` | `<user_after>` | memory lesson |
| `<sachverhalt>` | `<case>` | `agent/judge/generative.ts` |

Not prompt tags, but placeholders in text that were translated with it:
`load("<quelle>")` → `load("<source>")` and `mail_<postfach>` →
`mail_<account>` (`agent/tools/analyze.ts`), `<nummer>` → `<number>`
(redaction in `health/delivery.ts`), `<konto>:<id beim Anbieter>` →
`<account>:<provider id>` (`mail/types.ts`), `<suchwort>` → `<search_term>`
(`config/env.ts`), and the format comments in `integrations/seal.ts`,
`vault/sealbox.ts` and `mail/brand.ts` (`<daten>` → `<data>`,
`<wegwerf-schlüssel>` → `<ephemeral-key>`, `<lokal>` → `<local>`,
`<zufall>` → `<random>`, `<prüfsumme>` → `<checksum>`). `<iv>`, `<tag>`,
`<kid>`, `<domain>`, `<id>`, `<name>` stay.

Stored data keeps the language it was written in (facts, user model,
lessons, stored previews). The model reads it in any language. Standing
approvals are stored as structured keys (`encodeGrant` in
`src/agent/tools/grants.ts`) and put into words only when shown
(`describeGrant`, "yes always covers …", "serain revoke"), in the language of
that moment; keys from before the structured form appear as stored.
