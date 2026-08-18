import { currentApproval, type WorkItemApproval } from './approval-rows.js';
import type { ApprovalDecision } from './approvals.js';
import type { WorkItem } from './store.js';

export interface TodoApprovalDecisionEvent {
  item: WorkItem;
  approval: WorkItemApproval;
  decision: ApprovalDecision;
  decidedBy: string;
}

export type TodoApprovalDecisionListener = (event: TodoApprovalDecisionEvent) => void | Promise<void>;

let approvalDecisionListener: TodoApprovalDecisionListener | null = null;

export function setTodoApprovalDecisionListener(listener: TodoApprovalDecisionListener | null): void {
  approvalDecisionListener = listener;
}

/** Notify the consumer that mirrored this approval after its transaction commits. */
export function notifyApprovalDecision(item: WorkItem, decision: ApprovalDecision, decidedBy: string): void {
  const approval = currentApproval(item.id);
  if (!approval || !approvalDecisionListener) return;
  try {
    const maybe = approvalDecisionListener({ item, approval, decision, decidedBy });
    if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
      void (maybe as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Best-effort bridge: the decision has already committed.
  }
}
