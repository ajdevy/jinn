import { useSyncExternalStore } from "react"

/**
 * Which talk session is open, for the surfaces that have to name one.
 *
 * Held outside React because the session belongs to the realtime transport,
 * which is not a component — and does not exist in the browser yet. Nothing
 * calls the setter in production today, so the orb mounts against `null` and
 * the action log keeps its entries in page memory alone. The seam is a named
 * module rather than an inline `null` so that landing the transport is a call
 * to {@link setTalkSessionId}, not a search for where one would go.
 */

let sessionId: string | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Name the open talk session, or `null` once it has closed. */
export function setTalkSessionId(id: string | null): void {
  if (id === sessionId) return
  sessionId = id
  for (const listener of listeners) listener()
}

export function useTalkSessionId(): string | null {
  return useSyncExternalStore(subscribe, () => sessionId, () => null)
}
