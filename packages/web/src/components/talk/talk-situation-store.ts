import { useSyncExternalStore } from "react"
import type { Situation } from "./situation-payload"

/**
 * One situation at a time, held outside React so anything can raise one — a
 * realtime session, a harness button — without owning the surface or being
 * anywhere near it in the tree. The talk surface is mounted once, above the
 * router, and there is no prop path to it.
 */

let current: Situation | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Raise a situation, replacing whatever was up. */
export function presentSituation(situation: Situation): void {
  current = situation
  emit()
}

/** Take the situation down. Answering and dismissing both land here. */
export function dismissSituation(): void {
  if (!current) return
  current = null
  emit()
}

export function useSituation(): Situation | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
