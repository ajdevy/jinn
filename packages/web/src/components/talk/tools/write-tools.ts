import { api, type WorkItemStatusWire } from "@/lib/api"
import { newTodoEditRequest } from "@/routes/todos/todo-edit-request"
import { takeUndo } from "../talk-undo-store"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { UNDO_TOOL, fastWrite, writeFailed } from "./write-lane"

/**
 * The speak-and-go lane: internal, cheap, and reversible writes.
 *
 * Each one declares the reversal it hands to {@link fastWrite}, which is what
 * earns it the fast lane. `cancelled` is the exception the status tool carries:
 * a board gesture is one thing, and closing work the operator did not close is
 * another, so that one word takes the consent path instead.
 */

const TALK = "talk" as const

/** Statuses an agent may move a Todo to; `cancelled` is deliberately here and
 *  handled apart, because the model has to be able to ASK for it in order for
 *  the sheet to be what says no. */
const STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled",
]

const commentTodo: TalkTool = {
  name: "talk_comment_todo",
  description: "Leave a comment on a Todo. Reversible for a short window afterwards.",
  exposure: "on-intent",
  parameters: params(
    { id: str("The full Todo id, such as \"ABC-59\"."), body: str("The comment to leave, in the operator's words.") },
    ["id", "body"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const body = String(args.body)
    try {
      const { comment } = await api.addWorkItemComment(id, body, undefined, TALK)
      return fastWrite({
        tool: "talk_comment_todo",
        subject: id,
        performed: `Commented on ${id}.`,
        reverse: async () => { await api.deleteWorkItemComment(id, comment.id) },
      })
    } catch (error) {
      return writeFailed(`comment on ${id}`, error)
    }
  },
}

const createTodo: TalkTool = {
  name: "talk_create_todo",
  description: "Create a Todo. It starts in the backlog with nobody assigned.",
  exposure: "on-intent",
  parameters: params(
    {
      title: str("The Todo's title — one line, what the work is."),
      body: str("The detail, if the operator gave any."),
      parentId: str("The id of the Todo this belongs under, if it is a sub-task."),
    },
    ["title"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const title = String(args.title)
    try {
      const { workItem } = await api.createWorkItem({
        title,
        ...(typeof args.body === "string" && args.body ? { body: args.body } : {}),
        ...(typeof args.parentId === "string" && args.parentId ? { parentId: args.parentId } : {}),
      }, TALK)
      return fastWrite({
        tool: "talk_create_todo",
        subject: workItem.id,
        performed: `Created ${workItem.id}: ${workItem.title}.`,
        data: { title: workItem.title, status: workItem.status },
        // Archive rather than delete: the row and its audit survive, which is
        // what "undo" means everywhere else in the ledger.
        reverse: async () => { await api.archiveWorkItem(workItem.id) },
      })
    } catch (error) {
      return writeFailed(`create a Todo titled "${title}"`, error)
    }
  },
}

/** Cancelling closes work. It is reachable, but only through the sheet, and it
 *  is never offered an undo — a reopened Todo is a decision of its own. */
async function cancelTodo(id: string, note: string | undefined): Promise<ToolResult> {
  try {
    const { workItem } = await api.setWorkItemStatus(id, "cancelled", note, TALK)
    return { ok: true, data: { performed: `Cancelled ${id}.`, subject: workItem.id } }
  } catch (error) {
    return writeFailed(`cancel ${id}`, error)
  }
}

const setTodoStatus: TalkTool = {
  name: "talk_set_todo_status",
  description: "Move a Todo to another status. Cancelling asks first; every other move is reversible for a short window.",
  exposure: "on-intent",
  parameters: params(
    {
      id: str("The full Todo id."),
      status: str("The status to move it to.", STATUSES),
      note: str("Why, when the move is to blocked or escalated."),
    },
    ["id", "status"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const status = String(args.status) as WorkItemStatusWire
    const note = typeof args.note === "string" && args.note ? args.note : undefined
    if (status === "cancelled") {
      return withConsent(
        { tool: "talk_set_todo_status", title: `Cancel ${id}?`, hint: "Cancelling closes the work. There is no undo for it.", confirm: "Cancel it", subject: id },
        () => cancelTodo(id, note),
      )
    }
    try {
      const before = await api.getWorkItem(id)
      const wasStatus = before.workItem.status
      const { workItem } = await api.setWorkItemStatus(id, status, note, TALK)
      return fastWrite({
        tool: "talk_set_todo_status",
        subject: id,
        performed: `Moved ${id} to ${status}.`,
        data: { from: wasStatus, status: workItem.status },
        reverse: async () => { await api.setWorkItemStatus(id, wasStatus, undefined, TALK) },
      })
    } catch (error) {
      return writeFailed(`move ${id} to ${status}`, error)
    }
  },
}

const assignTodo: TalkTool = {
  name: "talk_assign_todo",
  description: "Assign a Todo to an employee. Reversible for a short window afterwards.",
  exposure: "on-intent",
  parameters: params(
    { id: str("The full Todo id."), assignee: str("The employee's name, such as \"a-lead\".") },
    ["id", "assignee"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const assignee = String(args.assignee)
    try {
      const before = await api.getWorkItem(id)
      const wasAssignee = before.workItem.assignee
      const { workItem } = await api.assignWorkItem(id, assignee, TALK)
      return fastWrite({
        tool: "talk_assign_todo",
        subject: id,
        performed: `Assigned ${id} to ${assignee}.`,
        data: { from: wasAssignee, assignee },
        // The assign route requires a name, so putting an unassigned Todo back
        // has to go through the version-fenced edit lane instead.
        reverse: async () => {
          if (wasAssignee) await api.assignWorkItem(id, wasAssignee, TALK)
          else await api.updateWorkItem(id, newTodoEditRequest({ assignee: null }, workItem.version ?? 1))
        },
      })
    } catch (error) {
      return writeFailed(`assign ${id} to ${assignee}`, error)
    }
  },
}

const labelTodo: TalkTool = {
  name: "talk_label_todo",
  description: "Replace a Todo's labels with the ones given. Only existing labels can be applied.",
  exposure: "on-intent",
  parameters: params(
    { id: str("The full Todo id."), labels: str("The full set of label names, comma-separated. Empty clears them.") },
    ["id", "labels"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const next = String(args.labels).split(",").map((name) => name.trim()).filter(Boolean)
    try {
      const before = await api.getWorkItem(id)
      const wasLabels = (before.labels ?? []).map((label) => label.name)
      const { labels } = await api.setWorkItemLabels(id, next, TALK)
      const applied = labels.map((label) => label.name)
      return fastWrite({
        tool: "talk_label_todo",
        subject: id,
        performed: applied.length > 0 ? `Labelled ${id}: ${applied.join(", ")}.` : `Cleared the labels on ${id}.`,
        data: { from: wasLabels, labels: applied },
        reverse: async () => { await api.setWorkItemLabels(id, wasLabels, TALK) },
      })
    } catch (error) {
      return writeFailed(`label ${id}`, error)
    }
  },
}

const undoLastWrite: TalkTool = {
  name: UNDO_TOOL,
  description: "Reverse the last speak-and-go write, while its window is still open. Every such write names this tool as its undo.",
  exposure: "on-intent",
  parameters: params({}),
  execute: async (): Promise<ToolResult> => {
    const outcome = await takeUndo()
    return outcome.ok
      ? { ok: true, data: { performed: `Undone: ${outcome.performed}` } }
      : { ok: false, error: outcome.error }
  },
}

/** The speak-and-go tools, plus the reversal they all hand back. */
export const WRITE_TOOLS: readonly TalkTool[] = [
  commentTodo,
  createTodo,
  setTodoStatus,
  assignTodo,
  labelTodo,
  undoLastWrite,
]

/** The subset that must never succeed without a reversal on the table. */
export const FAST_LANE_TOOLS: readonly TalkTool[] = [commentTodo, createTodo, setTodoStatus, assignTodo, labelTodo]
