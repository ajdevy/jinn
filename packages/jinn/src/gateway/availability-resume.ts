import { logger } from "../shared/logger.js";
import {
  AVAILABILITY_RESUME_ACTOR,
  startAvailabilityResumeSweep,
  type AvailabilityRearmResult,
} from "../work-items/availability-resume.js";
import { getWorkItemLabels, normalizeLabelName, setWorkItemLabels } from "../work-items/labels.js";
import type { WorkItemStatus } from "../work-items/store.js";
import { transition, TransitionError } from "../work-items/transitions.js";
import { owningWorkflowId } from "../work-items/workflow-ownership.js";
import { resolveRearmTarget } from "../workflows/rearm-target.js";
import type { WorkflowRepository } from "../workflows/repository.js";

/**
 * The gateway half of the availability resume sweep (PLA-153): the sweep decides
 * WHEN a Todo comes back, this decides WHERE it lands.
 *
 * It lives here because answering that means reading a Workflow definition, and
 * `work-items/` does not import `workflows/`. Everything it does — the revision
 * lane on `transition`, the trigger lookup — is machinery that already existed
 * for a rejected gate sending work round again.
 */
export function startAvailabilityResumes(repository: WorkflowRepository): () => void {
  return startAvailabilityResumeSweep({ rearm: (todoId) => availabilityRearm(todoId, repository) });
}

/** One re-arm. Exported for tests; the sweep above is the only caller in anger. */
export function availabilityRearm(todoId: string, repository: WorkflowRepository): AvailabilityRearmResult {
  const workflowId = owningWorkflowId(todoId);
  if (workflowId === undefined) {
    return { unavailable: "no Workflow run has ever driven this Todo, so nothing says where a re-arm would land" };
  }
  const target = resolveRearmTarget(repository.getDefinition(workflowId), workflowId);
  if ("unavailable" in target) return target;

  if (target.label !== undefined) restoreArmingLabel(todoId, target.label);
  try {
    const moved = transition(todoId, target.status as WorkItemStatus, AVAILABILITY_RESUME_ACTOR, {
      requeue: true,
      detail: { workflowId, availabilityResume: true },
    });
    // A Todo already sitting at that status takes no status write at all, so no
    // event reaches the trigger and nothing re-arms. Reporting it as a landing
    // would spend this failure's one resume on a move that never happened.
    if (moved.event === undefined) {
      return { unavailable: `it is already \`${target.status}\`, so a re-arm writes no status event for the trigger to fire on` };
    }
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    return { unavailable: `it could not be moved to \`${target.status}\`: ${error.message}` };
  }
  return { status: target.status, ...(target.label === undefined ? {} : { label: target.label }) };
}

/**
 * Put the trigger's label back if it has gone missing, because a status move
 * that misses the label filter fires nothing and the Todo would stop again one
 * silent step further on. Restoring it at re-arm time is deliberately all this
 * does — why labels go missing at all is its own question.
 */
function restoreArmingLabel(todoId: string, label: string): void {
  const present = getWorkItemLabels(todoId);
  let name: string;
  try {
    name = normalizeLabelName(label);
  } catch {
    return;
  }
  if (present.some((existing) => existing.id === label || existing.name === name)) return;
  try {
    setWorkItemLabels(todoId, [...present.map((existing) => existing.id), label], AVAILABILITY_RESUME_ACTOR);
  } catch (error) {
    // An unknown label ref is the workflow author's to fix; the re-arm still
    // happens, and the trigger's own suppression note will name the filter.
    logger.warn(`Todo ${todoId} could not have its arming label \`${label}\` restored: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}
