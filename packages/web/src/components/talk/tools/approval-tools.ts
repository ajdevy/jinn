import { api, type WorkItemFullWire, type WorkItemStatusWire } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { writeFailed } from "./write-lane"

/**
 * The decisions, spoken.
 *
 * Approving a gate, deciding a workflow's land approval and unblocking a Todo
 * are the three verbs the board has that reach past this browser the moment they
 * land: an approval releases whatever was waiting on it, a land approval merges
 * a branch, and an unblock puts an agent back on the work. None of the three has
 * a reversal, so all three are situation-first — the sheet is what stands in for
 * the undo the fast lane would have offered.
 *
 * Each reads the thing it is about to decide BEFORE it asks, so the sheet quotes
 * the real request rather than the model's summary of it, and so a call against
 * a gate that is not waiting is refused without troubling the operator at all.
 */

const TALK = "talk" as const
const DECISIONS = ["approve", "reject"] as const
type Decision = (typeof DECISIONS)[number]

/** What the edge map offers out of `blocked`. Whether THIS Todo may take one of
 *  them now still depends on its sub-tasks, and is checked when the call comes. */
const UNBLOCK_TARGETS: readonly WorkItemStatusWire[] = legalTargets("blocked").map((target) => target.status)

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * Why the decision as spoken cannot be made, or null when it can.
 *
 * A gate that offers options asks WHICH ONE, not whether, so approving it
 * without naming one would be the model picking on the operator's behalf — and
 * a picked option that is not on the list is a mishearing, not a vote.
 */
function refuseDecision(gate: WorkItemFullWire, decision: Decision, choice: string | undefined): string | null {
  if (gate.approvalState !== "pending") {
    return `${gate.id} has nothing waiting to be decided — its approval is ${gate.approvalState ?? "not set"}. Say so, and nothing was written.`
  }
  const options = gate.approvalOptions ?? []
  if (decision !== "approve" || options.length === 0) return null
  if (!choice) {
    return `${gate.id} asks which one, not whether: it offers ${options.join(", ")}. Ask the operator which they want and call this again with "choice".`
  }
  if (!options.includes(choice)) {
    return `"${choice}" is not one of the options on ${gate.id} — it offers ${options.join(", ")}. Read them out and let the operator pick, rather than deciding on the nearest.`
  }
  return null
}

const decideApproval: TalkTool = {
  name: "talk_decide_approval",
  description:
    "Approve or send back a Todo's pending approval. Asks first: whatever was waiting on the gate moves as soon as it is decided, and there is no way to take a decision back.",
  exposure: "on-intent",
  parameters: params(
    {
      id: str("The full Todo id, such as \"ABC-59\"."),
      decision: str("Approve it, or reject it to send it back.", DECISIONS),
      note: str("What the operator said about the decision, in their words."),
      choice: str("Which of the gate's offered options they picked, when it asks for one."),
    },
    ["id", "decision"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const decision = String(args.decision) as Decision
    const note = optional(args.note)
    const choice = optional(args.choice)

    let gate: WorkItemFullWire
    try {
      gate = (await api.getWorkItem(id)).workItem
    } catch (error) {
      return writeFailed(`read ${id} before deciding its approval`, error)
    }
    const refusal = refuseDecision(gate, decision, choice)
    if (refusal) return { ok: false, error: refusal }

    const verb = decision === "approve" ? "Approve" : "Send back"
    return withConsent(
      {
        tool: "talk_decide_approval",
        title: `${verb} ${id}?`,
        hint: `It asks: ${gate.approvalRequest ?? "(the gate did not say what it wants)"}${choice ? ` — picking ${choice}` : ""}`,
        confirm: `${verb} it`,
        subject: id,
      },
      async () => {
        try {
          await api.decideWorkItemApproval(id, decision, note, choice)
          return { ok: true, data: { performed: `${decision === "approve" ? "Approved" : "Sent back"} ${id}.`, subject: id, ...(choice ? { choice } : {}) } }
        } catch (error) {
          return writeFailed(`decide the approval on ${id}`, error)
        }
      },
    )
  },
}

const decideWorkflowApproval: TalkTool = {
  name: "talk_decide_workflow_approval",
  description:
    "Approve or reject the node a workflow run is waiting on. Asks first: an approved gate lets the run carry on immediately, and what it then does cannot be undone.",
  exposure: "on-intent",
  parameters: params(
    {
      id: str("The workflow id."),
      runId: str("The id of the run that is waiting."),
      decision: str("Approve the waiting node, or reject it.", DECISIONS),
      reason: str("Why, in the operator's words."),
    },
    ["id", "runId", "decision"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const runId = String(args.runId)
    const decision = String(args.decision) as Decision
    const reason = optional(args.reason)

    let run
    try {
      run = await api.getWorkflowRunV2(id, runId)
    } catch (error) {
      return writeFailed(`read run ${runId} before deciding its approval`, error)
    }
    const waiting = run.approvals.find((approval) => approval.status === "pending")
    if (!waiting) {
      return {
        ok: false,
        error: `Run ${runId} has nothing waiting for an approval — it is ${run.status}. Say so, and nothing was written.`,
      }
    }

    const verb = decision === "approve" ? "Approve" : "Reject"
    return withConsent(
      {
        tool: "talk_decide_workflow_approval",
        title: `${verb} "${waiting.nodeId}" on run ${runId}?`,
        hint: decision === "approve"
          ? "The run carries straight on from here, and what it does next cannot be taken back."
          : "The run stops at this node.",
        confirm: `${verb} it`,
        subject: runId,
      },
      async () => {
        try {
          // The revision comes from the run just read, never from anything
          // remembered: it is the fence that makes this decision the one made
          // about the state the operator was shown.
          await api.decideWorkflowApprovalV2(id, runId, waiting.nodeId, {
            decision,
            expectedRevision: run.revision,
            ...(reason ? { reason } : {}),
          })
          return { ok: true, data: { performed: `${decision === "approve" ? "Approved" : "Rejected"} "${waiting.nodeId}" on run ${runId}.`, subject: runId, nodeId: waiting.nodeId } }
        } catch (error) {
          return writeFailed(`decide the approval on run ${runId}`, error)
        }
      },
    )
  },
}

/** The close gate's pre-check, read the way the Todo peek reads it: a failed
 *  read is reported rather than counted as zero, because defaulting to zero
 *  would offer a close the gateway is about to refuse and blame the move for a
 *  read that never landed. */
async function openChildrenOf(id: string): Promise<number | { error: string }> {
  try {
    const { tree } = await api.getWorkItemTree(id)
    return (tree.root.children ?? []).filter((child) => child.status !== "done" && child.status !== "cancelled").length
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
    return { error: `Could not read ${id}'s sub-tasks, so the move cannot be checked against the close gate: ${why}.` }
  }
}

const unblockTodo: TalkTool = {
  name: "talk_unblock_todo",
  description:
    "Move a blocked Todo back into the flow, with the reason it is no longer blocked. Asks first: unblocking releases the work to whoever picks it up, and no undo reaches them.",
  exposure: "on-intent",
  parameters: params(
    {
      id: str("The full Todo id."),
      status: str("Where it goes now.", UNBLOCK_TARGETS),
      note: str("Why it is no longer blocked, in the operator's words. Ask them if they have not said."),
    },
    ["id", "status", "note"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const status = String(args.status) as WorkItemStatusWire
    const note = String(args.note)

    let was: WorkItemStatusWire
    try {
      was = (await api.getWorkItem(id)).workItem.status
    } catch (error) {
      return writeFailed(`read ${id} before unblocking it`, error)
    }
    if (was !== "blocked") {
      return { ok: false, error: `${id} is not blocked — it is ${was}, so there is nothing to unblock. Use "talk_set_todo_status" to move it.` }
    }

    const children = await openChildrenOf(id)
    if (typeof children !== "number") return { ok: false, error: children.error }

    const offered = legalTargets("blocked", { openChildren: children })
    const target = offered.find((option) => option.status === status)
    if (!target || target.gated) {
      const open = offered.filter((option) => !option.gated).map((option) => option.status).join(", ")
      const why = target?.reason ? ` (${target.reason})` : ""
      return { ok: false, error: `${id} cannot move from blocked to ${status}${why}. It can go to: ${open}.` }
    }

    return withConsent(
      {
        tool: "talk_unblock_todo",
        title: `Unblock ${id} to ${status}?`,
        hint: note,
        confirm: "Unblock it",
        subject: id,
      },
      async () => {
        try {
          await api.setWorkItemStatus(id, status, note, TALK)
          return { ok: true, data: { performed: `Unblocked ${id} to ${status}.`, subject: id, from: "blocked", status } }
        } catch (error) {
          return writeFailed(`unblock ${id} to ${status}`, error)
        }
      },
    )
  },
}

export const APPROVAL_TOOLS: readonly TalkTool[] = [decideApproval, decideWorkflowApproval, unblockTodo]
