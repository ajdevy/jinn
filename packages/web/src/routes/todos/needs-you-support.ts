import type { WorkItemCompactWire } from "@/lib/api"
import type { StateGlyphKey } from "./state-glyph"

/** Which of the inbox's three kickers an entry belongs to. A pending gate wins
 *  over the status, because a Todo can be blocked AND holding a decision. */
export type AttentionKind = "approval" | "escalated" | "blocked"

export function attentionKind(item: WorkItemCompactWire): AttentionKind {
  if (item.approvalState === "pending") return "approval"
  return item.status === "blocked" ? "blocked" : "escalated"
}

export function stateKey(kind: AttentionKind): StateGlyphKey {
  return kind === "approval" ? "approval" : kind
}
