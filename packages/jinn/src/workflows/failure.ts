import type { WorkflowError } from "./runtime.js";
import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";

/**
 * How a workflow decides whether a failed attempt is worth re-dispatching.
 *
 * The boundary is "did the work happen and fail" versus "did the attempt never
 * land". An attempt that never landed costs nothing to repeat — the retry is the
 * SAME request, not a second one. An employee that ran and reported failure is a
 * verdict: re-dispatching it pays twice for a decision already made and can
 * override a phase that deliberately refused to proceed.
 *
 * Most of that is decided STRUCTURALLY, by which path the failure arrived on —
 * a `startAttempt` throw or a gateway restart is an undelivered attempt whatever
 * its message says, and a submitted failure is a verdict whatever its message
 * says. The signatures below are only for the one path with no structure to read:
 * an engine reporting that its turn failed, where the provider's reason exists
 * solely as prose.
 *
 * There the vocabulary is closed and anything unrecognised is terminal. Guessing
 * generously spends real money on real failures, so the default is deny.
 */

/**
 * Whether an engine diagnostic describes an upstream/transport fault.
 *
 * Read off the shared taxonomy: the two classes that mean the request never got
 * a real answer. Deliberately NOT retried are the classes that name a decision —
 * `rate-limit`/`quota` (the session manager owns rate-limit waiting, so a
 * workflow retry on top of it is pure quota burn), `auth-terminal`, and
 * `terminal` (a retry cannot fix a credential, a quota, or a malformed request).
 * A provider can be both overloaded and throttling; that text is retried here,
 * exactly as it was before the classes were named.
 */
export function isTransportFailure(message: string): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(message), "provider-outage", "network");
}

/**
 * Wrap a failure whose only account of itself is its message: an engine turn that
 * reported an error, or a run-level fault (an unavailable employee, control flow
 * that did not settle). Retryable only when the message names a transport fault.
 */
export function workflowError(error: unknown, nodeId: string, attempt?: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: "workflow-step-failed",
    message: value.message,
    retryable: isTransportFailure(value.message),
    nodeId,
    ...(attempt ? { attempt } : {}),
  };
}

/**
 * A dispatch that threw before the attempt reached a session. Nothing ran, so
 * this is the undelivered-attempt case by construction — no message-matching,
 * because the diagnostic belongs to whatever failed to spawn, not to a provider.
 */
export function dispatchFailure(error: unknown, nodeId: string, attempt: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return { code: "workflow-dispatch-failed", message: value.message, retryable: true, nodeId, attempt };
}

/**
 * An attempt killed under the runtime — most often a gateway restart while it was
 * running. The turn was interrupted rather than judged, so like a timeout or a
 * missing output block there is no verdict to honour and the phase re-runs.
 */
export function interruptedAttemptFailure(message: string, nodeId: string, attempt: number): WorkflowError {
  return { code: "workflow-attempt-interrupted", message, retryable: true, nodeId, attempt };
}
