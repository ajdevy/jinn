import { useSyncExternalStore } from "react"
import type { Situation } from "./situation-payload"

/**
 * One situation at a time, held outside React so anything can raise one — a
 * realtime session, a harness button — without owning the surface or being
 * anywhere near it in the tree. The talk surface is mounted once, above the
 * router, and there is no prop path to it.
 *
 * A situation can also be ASKED rather than raised: `askSituation` hands back the
 * answer, which is what lets a write wait for the operator's consent before it
 * touches anything.
 */

let current: Situation | null = null
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

/** The operator picked a card. */
export function answerSituation(choiceId: string): void {
  if (!current) return
  current = null
  settle(choiceId)
  emit()
}

/** Take the situation down unanswered. Escape, the scrim, and the slide-down all
 *  land here. */
export function dismissSituation(): void {
  if (!current) return
  current = null
  settle(null)
  emit()
}

export function useSituation(): Situation | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
