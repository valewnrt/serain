/**
 * Memory policy in one place (D6, D12, D13). Thresholds and window sizes live
 * here, not the hard safety and budget limits: those stay in
 * `src/config/limits.ts`. The split is deliberate: a threshold here makes
 * Serain more forgetful or more intrusive, a number there decides whether money
 * is spent.
 *
 * All probabilities refer to the output of the `judge` role. With the
 * generative backend they are self-estimated and not calibrated; the thresholds
 * are set cautiously accordingly and are among the things the eval tunes later.
 */
export const MEMORY = {
  /**
   * From here on, extraction is worth it. Below, nothing happens: a turn without
   * lasting content is the normal case, and every extraction costs a model
   * call.
   */
  gateThreshold: 0.6,

  /**
   * This many previous chat entries go into the gate and the extraction as
   * history. Without this history a partial retraction ("nah actually, an
   * espresso now and then") means nothing on its own, and that is exactly where
   * the live test on 2026-09-18 failed: the gate gave 0.35 because the sentence
   * alone says nothing about anything.
   *
   * The history serves understanding only. Still only what is in the owner's
   * current message is stored (D8.4); both prompts say so too.
   */
  writeContextTurns: 6,
  /** Upper bound for this history. It goes to an external provider (D3, D12). */
  writeContextMaxChars: 1_200,

  /**
   * Does the new fact replace an old one? From `supersedeHigh` on, it replaces.
   * Between `supersedeLow` and `supersedeHigh` both stay and the conflict is
   * queued as a question: silently overwriting would be the more expensive
   * mistake, because afterwards nobody sees that there was a doubt.
   * Below `supersedeLow` it is simply a new fact.
   */
  supersedeHigh: 0.8,
  supersedeLow: 0.45,

  /**
   * Ask only when a wrong assumption would be expensive (W20). The scale is
   * 0-indexed with four levels (see `IMPORTANCE_SCALE`); 1.5 means: on average
   * at least "noticeable".
   */
  conflictImportanceMin: 1.5,

  /** How many existing facts are checked as replacement candidates. */
  candidateLimit: 5,
  /** Similarity from which a fact counts as a replacement candidate at all. */
  candidateMinSimilarity: 0.55,

  /** Top-K facts per turn in the context. */
  recallLimit: 12,

  /**
   * What applies right now is in the context of every turn (`<current>`, memory
   * package of 2026-10-10), whatever the message sounds like: "in lisbon till
   * friday" has to reach "do i need a jacket?". At most this many situations.
   */
  situationLimit: 5,
  /**
   * A situation that begins within this many days already counts: on the
   * evening before the trip, "in lisbon from tomorrow" is what matters for
   * packing. It appears in the block with its start ("from").
   */
  situationLeadDays: 2,
  /** A situation without an end counts only this long after it was said; after that it is no longer current, but history. */
  situationFreshDays: 14,
  /** At most this many facts from the areas of an included playbook are added. */
  playbookFactLimit: 8,

  /**
   * Optional relevance gate over the recall candidates. Off by default: it costs
   * one judge request per candidate and thus more than the turn itself. On, it
   * is an option for later, when the memory is large enough that clutter costs
   * more than the check.
   */
  relevanceGate: false,
  relevanceThreshold: 0.5,

  /** Upper bound for the memory block in the prompt. Small context is budget policy (D3). */
  maxContextChars: 4_000,

  /** This many messages go to the model as history (previously in runtime.ts). */
  historyLimit: 20,

  /**
   * Summarize as soon as at least this many messages have dropped out of the
   * history window. Smaller would cost more than it helps: every summary costs a
   * model call.
   */
  summaryMinMessages: 10,
  /** Upper bound per summary, so a backlog does not turn into a giant prompt. */
  summaryMaxMessages: 60,
  /**
   * This many summaries are read by the protection of confidential values (D29).
   * Since older, matching summaries also enter the context (V3), any of them can
   * be in the prompt; the filter has to know them all.
   */
  summaryGuardLimit: 500,

  /** For `show_memory`: from this many characters on, ask for an area instead of sending everything. */
  showMemoryMaxChars: 2_000,

  /** Facts without an area (package 2 of 2026-10-08): one call assigns this many, at most once per hour. */
  areaBatch: 60,
  areaIntervalMs: 60 * 60_000,

  /**
   * Nightly consolidation (H1, D40). From this hour of the owner's wall-clock
   * time it runs once per day, but only if something changed in the facts.
   */
  consolidationHour: 3,
  /**
   * Cap for the learned part of the user model. It is in every turn next to the
   * owner's base text. More would be clutter that crowds out the rules in the
   * prompt.
   */
  learnedMaxChars: 3_500,
  /** At most this many lines a consolidation may delete from the owner's base text. The code discards more. */
  consolidationMaxBaseDeletions: 5,
  /** This many versions of the user model are kept for review and rollback. */
  userModelKeepVersions: 14,
  /**
   * If a forget hits more lines of the user model, Serain asks back instead of
   * deleting half a section on suspicion (D13: never guess).
   */
  forgetMaxModelLines: 8,
  /**
   * Forgetting beyond the one fact (D45 addendum): this many nearby facts per
   * search are checked by the model for whether they contain the detail. If it
   * hits more than `forgetMaxRelatedFacts` further ones, Serain asks back (D13:
   * never guess).
   */
  forgetRelatedLimit: 8,
  forgetMaxRelatedFacts: 5,

  /** History (V3, D41): this many messages get a vector per follow-up run, truncated to this many characters. */
  historyEmbedBatch: 30,
  historyEmbedMaxChars: 2_000,
  /** Hits of `search_history` and how much text per hit. */
  historySearchLimit: 8,
  historyHitMaxChars: 400,
  /**
   * Summaries in the context: the most recent by time, plus older ones that
   * match the message. Previously it was only the three most recent; what was
   * discussed two weeks ago was invisible, although it has a vector.
   */
  summaryRecentLimit: 2,
  summarySimilarLimit: 2,
  summarySimilarMin: 0.35,
} as const;

/**
 * Scale for the importance of a question back. 0-indexed, ascending: the index
 * is the value, both with Jev and with the generative backend.
 */
export const IMPORTANCE_SCALE = [
  "doesn't matter, a wrong assumption goes unnoticed",
  "slightly annoying, but quickly corrected",
  "noticeably expensive, time or money is lost",
  "very expensive, something important goes wrong",
] as const;

/**
 * Proposals the owner confirms, and approved procedures (V5, H5, D42). This too
 * is memory policy: a number here makes Serain ask more or forget more, it
 * grants no rights. What a procedure may do is written nowhere: it is text in
 * the prompt and lowers no tier.
 */
export const PROPOSALS = {
  /**
   * For this long after a 👎, the owner's next own message counts as the
   * correction to it. Longer would be guessing: after half an hour they are
   * usually talking about something else.
   */
  correctionWindowMs: 30 * 60_000,
  /** A sentence Serain would remember. Longer, it is no longer a rule but an explanation. */
  lessonMaxChars: 200,

  /**
   * The collected question goes out no earlier than Sunday at 18:00 (the owner's
   * wall-clock time), with at most three proposals, oldest first. What came in
   * after Sunday 18:00 waits for the next week. Not at night, not in the middle
   * of a conversation and not beyond the daily cap: the heartbeat's rules apply
   * to that (D19).
   */
  offerWeekday: 0,
  offerHour: 18,
  offerMaxItems: 3,
  /** Unanswered, open this long; after that the question expires silently. */
  offerTtlMs: 7 * 24 * 3_600_000,
  /** How often the scheduler clock checks at all whether to ask or to expire. */
  offerCheckIntervalMs: 10 * 60_000,

  /** `propose_procedure`: title, steps, how to recognize a matching task. */
  procedureTitleMaxChars: 80,
  procedureStepsMaxChars: 600,
  procedureWhenMaxChars: 160,
  /** Active procedures plus open questions about them. More would be no memory but a manual in the prompt. */
  maxActiveProcedures: 20,

  /** At most this many matching procedures per turn in the context. */
  procedureRecallLimit: 2,
  /**
   * From here on, a procedure matches via the embedding (title and recognition
   * cue against the owner's message). Not calibrated: set so that a turn without
   * relation gets none, to be tuned in operation (D42).
   */
  procedureMinSimilarity: 0.5,
  /** Or via full text: this many shared word stems, so that a single "mail" is not enough. */
  procedureMinSharedTerms: 2,
} as const;
