import type { CompanionErrorCode } from "../src/companion/protocol.js";

/** An error the server may see as an answer: a code plus one sentence, never a stack trace. */
export class ToolFailure extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    message: string,
  ) {
    super(message);
  }
}
