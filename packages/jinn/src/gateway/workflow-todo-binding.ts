import { parseTodoApprovalRef } from '../workflows/todo-approval-ref.js';
import type { WorkflowService } from '../workflows/service.js';
import type { WorkItem } from '../work-items/store.js';

/** Who a mirrored workflow gate reserved itself for: the human operator, or the
 *  COO's own lane. Distinct answers, because only one of them admits the portal
 *  session. */
export type WorkflowGateClass = 'operator' | 'coo';

/**
 * The class of the workflow gate this Todo's pending approval mirrors, if it
 * mirrors one and that gate reserved itself at all.
 *
 * Read back through the approval `ref` rather than copied onto the approval row:
 * the workflow definition is the single source of truth for who may decide, and
 * a denormalized copy could drift from it. A Todo approval that did not come
 * from a workflow, or whose run or node has since gone, is in no class — it
 * keeps ordinary hierarchy routing.
 */
export function approvalGateClass(item: WorkItem, service: WorkflowService | undefined): WorkflowGateClass | undefined {
  const origin = parseTodoApprovalRef(item.approvalRef);
  if (!service || !origin) return undefined;
  const node = service.getRun(origin.workflowId, origin.runId)?.definition.nodes
    .find((candidate) => candidate.id === origin.nodeId);
  if (node?.type !== 'approval') return undefined;
  if (node.config.operatorOnly === true) return 'operator';
  return node.config.decidableBy === 'coo' ? 'coo' : undefined;
}
