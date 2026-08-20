import { useState } from "react"
import { OptionPills } from "@/components/ui/option-pills"
import type { WorkflowRunDetailWire } from "@/lib/api"
import type { WorkflowNodeWire } from "./editor/ports"
import { Note, Section, formatStarted } from "./run-support"

type WorkflowApprovalWire = WorkflowRunDetailWire["approvals"][number]

/** What the operator adds to a decision: the variant they picked, and why. */
export interface ApprovalDecisionExtra {
  reason?: string
  choice?: string
}

/** The variants this gate offers. Read off the definition snapshot the
 *  inspector already holds, the way conditionCases() reads a condition's
 *  branches — the run wire carries no copy of them. */
function approvalOptions(node: WorkflowNodeWire): string[] {
  const options = (node.config as { options?: unknown }).options
  if (!Array.isArray(options)) return []
  return options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
}

const SUBMIT =
  "focus-ring min-h-11 min-w-0 flex-1 truncate rounded-full px-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] outline-none transition-opacity hover:opacity-90 disabled:opacity-50 sm:min-h-9"

/** A settled gate still has to say which variant was picked. On a gate that
 *  offered choices the pick *is* the decision, and it outlives the decision on
 *  the node output — the approval record never carries it. */
function DecidedNote({ approval, choice }: { approval: WorkflowApprovalWire; choice?: string }) {
  return (
    <Note>
      {approval.status === "approved" ? "Approved" : "Rejected"}
      {choice ? ` · ${choice}` : ""}
      {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
      {approval.decidedAt ? ` · ${formatStarted(approval.decidedAt)}` : ""}
      {approval.reason ? ` — ${approval.reason}` : ""}
    </Note>
  )
}

/** The commit. Approve carries the pick in its label, so what is about to be
 *  sent is legible from the button itself. */
function DecideRow({ choice, deciding, needsChoice, onSubmit }: {
  choice: string | null
  deciding: boolean
  needsChoice: boolean
  onSubmit: (decision: "approve" | "reject") => void
}) {
  return (
    <div className="mt-2 flex gap-2">
      <button
        type="button"
        disabled={deciding || needsChoice}
        onClick={() => onSubmit("approve")}
        className={`${SUBMIT} bg-[var(--accent)] text-[var(--accent-contrast)]`}
      >
        {choice ? `Approve · ${choice}` : "Approve"}
      </button>
      <button
        type="button"
        disabled={deciding}
        onClick={() => onSubmit("reject")}
        className={`${SUBMIT} bg-[var(--fill-secondary)] text-[var(--system-red)]`}
      >
        Reject
      </button>
    </div>
  )
}

/** A pending gate: pick a variant when the node offers them, say why, decide.
 *  The reason rides along with either decision — it is the operator's word
 *  about the call, and a rejection without it says nothing to the run. */
function PendingDecision({ options, approval, onDecide, deciding }: {
  options: string[]
  approval: WorkflowApprovalWire
  onDecide: (nodeId: string, decision: "approve" | "reject", extra?: ApprovalDecisionExtra) => void
  deciding: boolean
}) {
  const [choice, setChoice] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const submit = (decision: "approve" | "reject") => {
    const trimmed = reason.trim()
    onDecide(approval.nodeId, decision, {
      ...(trimmed ? { reason: trimmed } : {}),
      ...(decision === "approve" && choice ? { choice } : {}),
    })
  }

  return (
    <div className="rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5">
      <p className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        Requested {formatStarted(approval.requestedAt)}
        {approval.approverRef ? ` · ${approval.approverRef}` : ""}
      </p>
      {options.length > 0 && (
        <OptionPills
          className="mt-2"
          label="Choose an option"
          options={options.map((option) => ({ value: option, label: option }))}
          selected={choice ?? ""}
          disabled={deciding}
          onSelect={(picked) => setChoice(picked === choice ? null : picked)}
        />
      )}
      <textarea
        value={reason}
        rows={2}
        disabled={deciding}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Reason"
        placeholder="Add a reason (optional)"
        className="focus-ring mt-2 w-full resize-none rounded-[10px] bg-[var(--fill-tertiary)] px-2.5 py-2 text-[length:var(--text-caption1)] leading-[1.5] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
      />
      <DecideRow
        choice={choice}
        deciding={deciding}
        needsChoice={options.length > 0 && choice === null}
        onSubmit={submit}
      />
    </div>
  )
}

export function ApprovalDecision({ node, approval, onDecide, deciding, choice }: {
  node: WorkflowNodeWire
  approval: WorkflowApprovalWire
  onDecide: (nodeId: string, decision: "approve" | "reject", extra?: ApprovalDecisionExtra) => void
  deciding: boolean
  choice?: string
}) {
  return (
    <Section title="Approval">
      {approval.status === "pending"
        ? (
          <PendingDecision
            // A pick and a reason belong to the gate they were typed on. The
            // inspector swaps one pending gate for another in place, so without
            // a key the next gate inherits a choice it never offered.
            key={approval.nodeId}
            options={approvalOptions(node)}
            approval={approval}
            onDecide={onDecide}
            deciding={deciding}
          />
        )
        : <DecidedNote approval={approval} choice={choice} />}
    </Section>
  )
}
