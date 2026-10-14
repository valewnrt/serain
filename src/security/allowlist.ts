import { normalizeE164 } from "../channel/e164.js";

/**
 * Ingress allowlist (D8.1). Only the owner's handle reaches the model. This check
 * runs before every LLM call and before every tool, and it knows only numbers,
 * no names and no content.
 */
export type IngressVerdict =
  | { allowed: true; from: string }
  | { allowed: false; reason: "group" | "unknown_sender" | "malformed_sender"; from: string };

export interface IngressCandidate {
  from: string;
  isGroup: boolean;
}

export function checkIngress(candidate: IngressCandidate, ownerPhone: string): IngressVerdict {
  const from = normalizeE164(candidate.from);
  if (!from) {
    return { allowed: false, reason: "malformed_sender", from: candidate.from };
  }
  // Groups are not planned in phase 0: by definition, third parties sit in on them.
  if (candidate.isGroup) {
    return { allowed: false, reason: "group", from };
  }
  const owner = normalizeE164(ownerPhone);
  if (!owner || from !== owner) {
    return { allowed: false, reason: "unknown_sender", from };
  }
  return { allowed: true, from };
}
