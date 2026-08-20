/* Which session the chat page selects once the active one is deleted. */

/**
 * The session to fall back to after deleting the ACTIVE session: its
 * neighbour in the visible order — the next row, else the previous, else
 * null (list empty / deleted row not visible). Pure so the post-delete
 * replace semantics are unit-testable.
 */
export function pickNeighborSessionId(visibleIds: string[], deletedId: string): string | null {
  const idx = visibleIds.indexOf(deletedId)
  if (idx === -1) return null
  if (idx + 1 < visibleIds.length) return visibleIds[idx + 1]
  if (idx - 1 >= 0) return visibleIds[idx - 1]
  return null
}

/**
 * The single post-delete fallback decision: the visible-order neighbour when
 * the deleted session is in the flat visible order, else the most recent
 * OTHER session (a session inside a collapsed Older group is not in the
 * visible order — real installs hit this constantly), else null (composer —
 * nothing left to select).
 */
export function pickDeleteFallbackId(
  visibleIds: string[],
  allIdsByRecency: string[],
  deletedId: string,
): string | null {
  const neighbor = pickNeighborSessionId(visibleIds, deletedId)
  if (neighbor) return neighbor
  return allIdsByRecency.find((id) => id !== deletedId) ?? null
}
