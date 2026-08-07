import type { WorkItemCommentWire, WorkItemEventWire } from "@/lib/api"

/* The two wire builders the task-page tests share: the feed model and the
 * rendered sections both speak in events and comments. */

export function event(id: string, kind: string, at: string, extra: Partial<WorkItemEventWire> = {}): WorkItemEventWire {
  return {
    id, workItemId: "PLA-12", kind, fromStatus: null, toStatus: null, actor: "operator",
    detail: null, createdAt: at, ...extra,
  }
}

export function comment(id: string, body: string, at: string, extra: Partial<WorkItemCommentWire> = {}): WorkItemCommentWire {
  return {
    id, workItemId: "PLA-12", parentCommentId: null, authorKind: "employee", author: "mason",
    body, createdAt: at, editedAt: null, deletedAt: null, ...extra,
  }
}
