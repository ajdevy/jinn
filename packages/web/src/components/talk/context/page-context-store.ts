/**
 * The current page snapshot, held where a non-React reader can get at it.
 *
 * The router publishes here on every navigation and the talk driver subscribes,
 * which is the whole seam: neither of them is a component, so neither of them
 * can be handed this through a render. Same shape as `talk-session-store.ts`.
 *
 * A republish of an unchanged snapshot is dropped. React Router notifies on more
 * than the location, and an identical push would cost a `session.update` for a
 * page that did not move.
 */
import { describeLocation, type PageSnapshot } from "./page-snapshot"

/** Chat at home, which is where the app opens. `main.tsx` publishes the real
 *  location as soon as the router exists, so this stands for one tick. */
const INITIAL = Object.freeze(describeLocation("/", ""))

let current: PageSnapshot = INITIAL
const listeners = new Set<() => void>()

function sameEntries(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

function sameSnapshot(a: PageSnapshot, b: PageSnapshot): boolean {
  return a.kind === b.kind
    && a.path === b.path
    && a.selection?.kind === b.selection?.kind
    && a.selection?.id === b.selection?.id
    && sameEntries(a.params, b.params)
    && sameEntries(a.filters, b.filters)
}

/** Name where the operator is now. Frozen, so a subscriber that holds on to one
 *  is holding the page as it was, not a value that changes under it. */
export function publishPageContext(next: PageSnapshot): void {
  if (sameSnapshot(current, next)) return
  current = Object.freeze(next)
  for (const listener of listeners) listener()
}

export function getPageContext(): PageSnapshot {
  return current
}

export function subscribePageContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: back to the opening page, with nobody listening. */
export function resetPageContext(): void {
  current = INITIAL
  listeners.clear()
}

/** Test-only. A session that drops its connection must let go of the store too,
 *  and a leaked subscription is invisible from outside — the driver it belongs
 *  to just goes on pushing at a channel that is gone. This is how that is
 *  asserted rather than assumed. */
export function pageContextListenerCount(): number {
  return listeners.size
}
