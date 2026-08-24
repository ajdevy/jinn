import { listWorkItemEvents } from "./event-log.js";

/**
 * Which Workflow was driving this Todo, read off the status moves its own runs
 * reflected onto it. Newest wins: a Todo re-armed into a different pipeline
 * since then belongs to that one.
 */
export function owningWorkflowId(todoId: string): string | undefined {
  const bound = listWorkItemEvents(todoId)
    .filter((event) => event.kind === "status_change" && typeof event.detail?.workflowId === "string");
  return bound.at(-1)?.detail?.workflowId as string | undefined;
}
