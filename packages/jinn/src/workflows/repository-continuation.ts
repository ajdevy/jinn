import type { WorkflowAttemptRecord } from './runtime.js';
import { decodeAttempt, type AttemptRow } from './repository-runs.js';

type WorkflowSqliteConnection = ConstructorParameters<typeof import('./repository.js').WorkflowRepository>[0];

export interface ContinuationAttemptQuery {
  workflowId: string;
  nodeId: string;
  /** The Todo this run is bound to. Runs bound to any other Todo — or to none —
   *  are invisible here, so a continuation can never cross Todos. */
  todoId: string;
  excludeRunId: string;
}

/**
 * The newest completed attempt of `nodeId` from an EARLIER run of the same
 * Workflow for the same Todo. This is what lets a re-armed run pick up the
 * engine session its predecessor left behind instead of starting cold.
 */
export function readContinuationAttempt(
  db: WorkflowSqliteConnection,
  query: ContinuationAttemptQuery,
): WorkflowAttemptRecord | null {
  const row = db.prepare(`SELECT a.* FROM workflow_attempts a JOIN workflow_runs r ON r.id = a.run_id
    WHERE r.workflow_id = @workflowId AND r.id <> @excludeRunId AND json_extract(r.trigger_json, '$.todoId') = @todoId
      AND a.node_id = @nodeId AND a.status = 'completed' AND a.session_id IS NOT NULL
    ORDER BY a.started_at DESC, a.run_id DESC, a.attempt DESC LIMIT 1`).get(query) as AttemptRow | undefined;
  return row ? decodeAttempt(row) : null;
}
