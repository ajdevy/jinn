/**
 * The Talk tool surface's handle on the app router.
 *
 * `main.tsx` registers the router's navigate as soon as it builds it. Going
 * through a module-level handle rather than `useNavigate` is what keeps the
 * navigation tools free of React: they are called by a transport, not from a
 * render, and a route change that has to wait for a hook round-trip cannot meet
 * the surface's latency budget.
 */

/** Returns the router's own completion promise, so a caller can time a tool call
 *  to the arrival rather than to the request. */
export type TalkNavigate = (path: string) => Promise<void>

let navigate: TalkNavigate | null = null

export function registerTalkNavigator(fn: TalkNavigate): void {
  navigate = fn
}

/** Null until the app has mounted. Callers report that as a tool failure rather
 *  than queueing — a voice caller needs to know the app was not ready. */
export function talkNavigator(): TalkNavigate | null {
  return navigate
}

/** Test-only: drop the registration so a suite starts from a known state. */
export function clearTalkNavigator(): void {
  navigate = null
}
