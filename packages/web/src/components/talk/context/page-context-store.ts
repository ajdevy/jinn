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
import { browserInstanceId } from "./browser-instance"
import { semanticScreenChanged } from "./screen-context-diff"
import { describeLocation, type PageSnapshot, type TalkScreenContext } from "./page-snapshot"

/** Chat at home, which is where the app opens. `main.tsx` publishes the real
 *  location as soon as the router exists, so this stands for one tick. */
function ambient(snapshot: PageSnapshot): TalkScreenContext {
  return {
    ...snapshot,
    version: 1,
    revision: 0,
    routeId: snapshot.kind === "chat" ? "chat" : snapshot.kind,
    capturedAt: new Date(0).toISOString(),
    freshness: snapshot.selection ? "partial" : "complete",
    missing: snapshot.selection ? ["selected-object"] : [],
    title: snapshot.kind,
    selectedObject: null,
    visibleItems: [],
    controls: [],
    meaningfulText: "",
    browserInstanceId: browserInstanceId(),
    focus: null,
    hidden: false,
    visualGaps: [],
  }
}

const INITIAL = Object.freeze(ambient(describeLocation("/", "")))

let current: TalkScreenContext = INITIAL
const listeners = new Set<() => void>()

/** Name where the operator is now. Frozen, so a subscriber that holds on to one
 *  is holding the page as it was, not a value that changes under it. */
export function publishPageContext(next: PageSnapshot): void {
  publishScreenContext(ambient(next))
}

export function publishScreenContext(next: TalkScreenContext): void {
  if (!semanticScreenChanged(current, next)) return
  current = Object.freeze({ ...next, revision: current.revision + 1 })
  for (const listener of listeners) listener()
}

export function getPageContext(): TalkScreenContext {
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
