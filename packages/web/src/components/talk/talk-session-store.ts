import { useSyncExternalStore } from "react"

/**
 * Which talk session is open, for the surfaces that have to name one.
 *
 * Held outside React because the session belongs to the realtime transport,
 * which is not a component. `transport/use-talk-session.ts` is the only thing
 * that calls {@link setTalkSessionId}: it names the session the moment
 * `POST /api/talk/sessions` returns one and clears it on close, on a failed
 * connect, and on unload. Everything downstream — the action log's gateway
 * copy above all — reads the answer from here rather than being handed it.
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
