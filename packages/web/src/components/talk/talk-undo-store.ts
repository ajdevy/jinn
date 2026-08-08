import { useSyncExternalStore } from "react"

/**
 * The fast lane's safety: one pending reversal at a time, offered for a fixed
 * window and then gone.
 *
 * Held outside React for the same reason the situation store is — a tool
 * executor is nowhere near the surface that draws the offer. The window is the
 * only thing standing between a misheard sentence and a write nobody asked for,
 * so it is a constant rather than a per-caller option: a tool that could pick
 * its own window could pick one too short to reach.
 */

export const UNDO_WINDOW_MS = 15_000

export interface UndoOffer {
  /** Past tense, what the strip says happened: "Commented on ABC-59". */
  performed: string
  /** Runs the reversal. Throwing leaves the write in place and says why. */
  reverse: () => Promise<void>
  /** Wall-clock deadline, so the strip can count down without owning a timer. */
  expiresAt: number
}

export type UndoOutcome =
  | { ok: true; performed: string }
  | { ok: false; error: string }

let offer: UndoOffer | null = null
let lapse: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function clear(): void {
  if (lapse) clearTimeout(lapse)
  lapse = null
  offer = null
}

/**
 * Offer a reversal for the next {@link UNDO_WINDOW_MS}. A second offer replaces
 * the first, whose write then stands — the strip shows one thing, so holding a
 * queue of reversals the operator cannot see would be a promise the surface
 * cannot keep.
 */
export function offerUndo(performed: string, reverse: () => Promise<void>): UndoOffer {
  clear()
  offer = { performed, reverse, expiresAt: Date.now() + UNDO_WINDOW_MS }
  lapse = setTimeout(() => {
    clear()
    emit()
  }, UNDO_WINDOW_MS)
  emit()
  return offer
}

/** Whether a reversal is still on the table. */
export function pendingUndo(): UndoOffer | null {
  return offer
}

/**
 * Run the pending reversal. Answers with a value in every case, including the
 * two failures worth telling apart: nothing was on offer, and the reversal
 * itself was refused by the gateway.
 */
export async function takeUndo(): Promise<UndoOutcome> {
  const taken = offer
  if (!taken) {
    return { ok: false, error: "There is nothing to undo — the last write's window has closed, or there has not been one." }
  }
  clear()
  emit()
  try {
    await taken.reverse()
    return { ok: true, performed: taken.performed }
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
    return { ok: false, error: `Could not undo "${taken.performed}": ${why}. The change is still in place.` }
  }
}

/** Drop the offer without running it — the write stands, same as lapsing. */
export function forgetUndo(): void {
  if (!offer) return
  clear()
  emit()
}

export function useUndoOffer(): UndoOffer | null {
  return useSyncExternalStore(
    subscribe,
    () => offer,
    () => null,
  )
}
