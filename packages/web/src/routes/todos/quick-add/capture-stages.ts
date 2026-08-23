import type { TodoCaptureWire } from "@/lib/api"

/**
 * What the operator is told a capture has done, and in what order.
 *
 * `captured` is the client's own fact — it is true the moment the text is
 * submitted, and it is the only stage the browser is entitled to assert. Every
 * other line comes from the server's derived state, so the strip can never show
 * progress the pipeline has not actually made.
 */

export const CAPTURE_STEPS = ["captured", "starting", "shaping", "created", "dispatching", "routed"] as const
export type CaptureStep = (typeof CAPTURE_STEPS)[number]

export function stepIndex(step: CaptureStep): number {
  return CAPTURE_STEPS.indexOf(step)
}

/** The line for a stage, given the facts that stage carries. */
export function stepLabel(step: CaptureStep, state: TodoCaptureWire | null): string {
  switch (step) {
    case "captured":
      return "Captured"
    case "starting":
      return "Session starting"
    case "shaping":
      return "Shaping"
    case "created":
      return state?.workItemId ? `${state.workItemId} created` : "Todo created"
    case "dispatching":
      return "Dispatching"
    case "routed":
      return routedLabel(state)
  }
}

function routedLabel(state: TodoCaptureWire | null): string {
  const routed = state?.routedTo
  if (!routed) return "Routed"
  if (routed.kind === "workflow") return `Running workflow ${routed.workflowName || routed.workflowId}`
  return `Delegated to ${routed.employee}`
}

/**
 * Fold a newly-read server state into the steps already shown.
 *
 * Stages are only ever ADDED, and only up to the one the server currently
 * reports: a capture that jumps straight from `shaping` to `routed` (because
 * the browser was asleep between polls) still shows the intermediate lines it
 * skipped, because those facts did happen — but nothing beyond what the wire
 * has said is ever drawn.
 */
export function foldCaptureSteps(seen: CaptureStep[], state: TodoCaptureWire): CaptureStep[] {
  if (state.stage === "failed") return seen
  const reached = stepIndex(state.stage as CaptureStep)
  if (reached < 0) return seen
  const next = CAPTURE_STEPS.slice(0, reached + 1)
  return next.length > seen.length ? next : seen
}
