import { getWorkItemSpend, listWorkItemEvents, type WorkItem } from "../work-items/store.js";
import { commentsTail } from "../work-items/comments.js";
import { isBlocked, listRelations } from "../work-items/relations.js";
import { getWorkItemLabels, type Label } from "../work-items/labels.js";
import { listApprovals } from "../work-items/approvals.js";
import { listWorkItemRuns } from "../work-items/runs.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";

/** The wire projections of a Todo the API routes return: one compact shape for
 *  lists, one enriched shape for the board, one full shape for the detail route. */

/** Compact wire summary (Todos v2 slice 3 adds `labels` + `blocked` — the
 *  board's chip/indicator data). List callers pass the pre-batched `extras`
 *  (ONE blockedSet + ONE labelSets query per page); single-item callers omit
 *  them and pay two per-item lookups. */
export function compactWorkItem(
  item: WorkItem,
  extras?: { blocked: Set<string>; labels: Map<string, Label[]> },
): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    assignee: item.assignee,
    department: item.department,
    createdBy: item.createdBy,
    parentId: item.parentId,
    rootId: item.rootId,
    depth: item.depth,
    dueAt: item.dueAt,
    source: item.source,
    sourceRef: item.sourceRef,
    rank: item.rank,
    labels: extras ? extras.labels.get(item.id) ?? [] : getWorkItemLabels(item.id),
    blocked: extras ? extras.blocked.has(item.id) : isBlocked(item.id),
    approvalState: item.approvalState,
    approvalRequest: item.approvalRequest,
    approvalRef: item.approvalRef,
    approvalOptions: item.approvalOptions,
    approvalChoice: item.approvalChoice,
    approvalOperatorOnly: item.approvalOperatorOnly,
    approvalTarget: item.approvalTarget,
    approvalEscalatedAt: item.approvalEscalatedAt,
    sessionRef: sessionRef(item),
    updatedAt: item.updatedAt,
  };
}

function sessionRef(item: WorkItem): Record<string, string> | null {
  if (!item.sourceRef) return null;
  const m = /^session:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (m) return m[2] ? { sessionId: m[1], ref: m[2] } : { sessionId: m[1] };
  const delegated = /^delegate:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (delegated) return delegated[2] ? { sessionId: delegated[1], ref: delegated[2] } : { sessionId: delegated[1] };
  return null;
}

export function fullWorkItemPayload(item: WorkItem): Record<string, unknown> {
  return {
    workItem: item,
    spendUsd: getWorkItemSpend(item.id),
    events: listWorkItemEvents(item.id),
    comments: commentsTail(item.id),
    relations: listRelations(item.id),
    labels: getWorkItemLabels(item.id),
    // Slice 4 (additive): the full approval history, oldest request first. The
    // legacy approval* fields on `workItem` remain the current row's values.
    approvals: listApprovals(item.id),
    // ICI-728 (additive): the attempt ledger, oldest first. Status says where the
    // Todo is; runs say what each attempt at it actually did.
    runs: listWorkItemRuns(item.id),
    // ICI-733 (additive): how the NEXT attempt runs — preloaded skills and the
    // engine/model override. Null when the Todo has never had any set.
    dispatchConfig: getTodoDispatchConfig(item.id) ?? null,
  };
}

/** The board/attention enrichment contract: only the two projections those
 * surfaces read. Heavy comments, relations, labels and approval history stay
 * behind the single-item detail route. */
export function openWorkItemPayload(item: WorkItem, events = listWorkItemEvents(item.id)): Record<string, unknown> {
  return {
    workItem: item,
    events,
  };
}
