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
 *
 * A situation can also be ASKED rather than raised: `askSituation` hands back the
 * answer, which is what lets a write wait for the operator's consent before it
 * touches anything. An asked situation is never deferrable — see
 * `dismissSituation`.
 */

let current: Situation | null = null
let deferred: Situation | null = null
/** Settles what `askSituation` handed out for `current`, if it was asked. */
let pending: ((choiceId: string | null) => void) | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Settle the waiter, if any, exactly once. Every way a situation can leave the
 *  screen goes through here: a caller blocked on an answer that never comes is
 *  a voice turn that never ends. */
function settle(choiceId: string | null): void {
  const waiter = pending
  pending = null
  waiter?.(choiceId)
}

/** Raise a situation, replacing whatever was up. */
export function presentSituation(situation: Situation): void {
  settle(null)
  current = situation
  emit()
}

/**
 * Raise a situation and wait for its answer: the id of the card the operator
 * picked, or null when they dismissed it or another situation replaced it.
 *
 * Null is the answer, not an error — a write gated on this reads it as a
 * refusal, which is the whole point of asking before acting.
 */
export function askSituation(situation: Situation): Promise<string | null> {
  return new Promise((resolve) => {
    presentSituation(situation)
    pending = resolve
  })
}

/**
 * The operator picked a card. The decision was made, so the deferred slot clears
 * with it: there is nothing left to raise again.
 */
export function answerSituation(choiceId: string): void {
  if (!current) return
  current = null
  deferred = null
  settle(choiceId)
  emit()
}

/**
 * Put the situation down without answering it. It keeps its place in the
 * deferred slot, whole, so `restoreDeferredSituation` can raise the same
 * decision again. Dragging the sheet away, Escape and a scrim tap all land here.
 *
 * An ASKED situation is the exception, and it does not defer: something is
 * blocked waiting on its answer, so putting it down has to mean "no" and settle
 * that waiter now. There would be nothing coherent to come back to — the write
 * has already been told it was refused — and the operator can simply ask again.
 * Like an answer, it empties the slot rather than leaving an older situation
 * there: the refusal is the last thing that happened, so the surface has nothing
 * to offer back.
 */
export function dismissSituation(): void {
  if (!current) return
  deferred = pending ? null : current
  current = null
  settle(null)
  emit()
}

/** Raise the last dismissed situation again, exactly as it was put down. */
export function restoreDeferredSituation(): void {
  if (!deferred) return
  current = deferred
  deferred = null
  emit()
}

/** The situation on screen, read outside React. A caller that must not act
 *  while the operator is being asked something consults this — a generic page
 *  action, which would otherwise be able to reach the sheet's own cards. */
export function currentSituation(): Situation | null {
  return current
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
