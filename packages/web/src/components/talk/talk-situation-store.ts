import { useSyncExternalStore } from "react"
import type { Situation } from "./situation-payload"

/**
 * One situation at a time, held outside React so anything can raise one — a
 * realtime session, a harness button — without owning the surface or being
 * anywhere near it in the tree. The talk surface is mounted once, above the
 * router, and there is no prop path to it.
 *
 * A second slot holds the last situation put down without an answer, which is
 * what makes throwing one away cheap: it is a "not now", not a "no".
 */

let current: Situation | null = null
let deferred: Situation | null = null
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

/**
 * Put the situation down without answering it. It keeps its place in the
 * deferred slot, whole, so `restoreDeferredSituation` can raise the same
 * decision again. Dragging the sheet away, Escape and a scrim tap all land here.
 */
export function dismissSituation(): void {
  if (!current) return
  deferred = current
  current = null
  emit()
}

/** The decision was made. Nothing is left pending, so the deferred slot clears. */
export function resolveSituation(): void {
  if (!current) return
  current = null
  deferred = null
  emit()
}

/** Raise the last dismissed situation again, exactly as it was put down. */
export function restoreDeferredSituation(): void {
  if (!deferred) return
  current = deferred
  deferred = null
  emit()
}

export function useSituation(): Situation | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}

/** What a dismissal left behind, for the surface that offers it back. */
export function useDeferredSituation(): Situation | null {
  return useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null,
  )
}
