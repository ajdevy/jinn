import { Plus, X } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Field, TextInput } from "./inspector-fields"
import type { WorkflowNodeOfType } from "./ports"

/**
 * Authoring the loop on a Workflow Call node: the bound, and the condition each
 * round is judged by.
 *
 * `continueWhile` always reads the node's own latest round, so the left side of
 * a check is a path into this node rather than a general binding — that is the
 * only thing it can mean, and offering a node picker would only offer wrong
 * answers. Everything else about the loop lives server-side, where
 * `validateExecutableWorkflow` has the last word.
 */

type CallConfig = WorkflowNodeOfType<"workflow-call">["config"]
type IterateWire = NonNullable<CallConfig["iterate"]>
type PredicateWire = IterateWire["continueWhile"][number]
type Operator = PredicateWire["operator"]

const OPERATORS: Operator[] = ["equals", "not-equals", "exists", "not-exists", "contains", "gt", "gte", "lt", "lte", "in"]
const MAX_ROUNDS = 20

const isOperator = (value: string): value is Operator => OPERATORS.some((operator) => operator === value)

/** Text typed into a comparison box, as the scalar the runner will compare. A
 *  bare number or boolean means what it looks like; everything else is a string. */
function fixedValue(text: string): string | number | boolean {
  if (text === "true") return true
  if (text === "false") return false
  const numeric = Number(text)
  return text.trim() !== "" && Number.isFinite(numeric) ? numeric : text
}

function comparisonText(right: PredicateWire["right"]): string {
  if (right?.source !== "fixed") return ""
  return right.value === null ? "" : String(right.value)
}

function roundPath(left: PredicateWire["left"]): string {
  return left.source === "fixed" ? "" : left.path
}

function defaultPredicate(nodeId: string): PredicateWire {
  return { left: { source: "node", nodeId, path: "fields.last.verdict" }, operator: "equals", right: { source: "fixed", value: "" } }
}

/** One check against the round that just finished: a path into this node's own
 *  latest output, an operator, and the value to compare it with. */
function CheckRow({ nodeId, check, onChange, onRemove }: {
  nodeId: string
  check: PredicateWire
  onChange: (next: PredicateWire) => void
  onRemove: () => void
}) {
  const compares = check.operator !== "exists" && check.operator !== "not-exists"
  return (
    <div className="mb-1.5 space-y-1">
      <div className="flex items-center gap-1">
        <TextInput
          aria-label="Round field"
          value={roundPath(check.left)}
          placeholder="fields.last.verdict"
          onChange={(event) => onChange({ ...check, left: { source: "node", nodeId, path: event.target.value } })}
        />
        <button
          type="button"
          aria-label="Remove check"
          onClick={onRemove}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)]"
        >
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="flex gap-1">
        <Select value={check.operator} onValueChange={(next) => { if (isOperator(next)) onChange({ ...check, operator: next }) }}>
          <SelectTrigger aria-label="Operator" className="h-8 w-auto min-w-[104px] flex-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPERATORS.map((operator) => (
              <SelectItem key={operator} value={operator}>{operator}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {compares && (
          <TextInput
            aria-label="Compare to"
            value={comparisonText(check.right)}
            placeholder="value"
            onChange={(event) => onChange({ ...check, right: { source: "fixed", value: fixedValue(event.target.value) } })}
            className="flex-1"
          />
        )}
      </div>
    </div>
  )
}

/** The bound and the checks, shown only once the loop is switched on. */
function LoopFields({ nodeId, iterate, onChange, checks, patch }: {
  nodeId: string
  iterate: IterateWire
  onChange: (next: IterateWire) => void
  checks: PredicateWire[]
  patch: (index: number, next: PredicateWire) => void
}) {
  return (
    <>
      <Field label="Max rounds">
        <TextInput
          type="number"
          min={1}
          max={MAX_ROUNDS}
          value={iterate.maxRounds ?? ""}
          placeholder="2"
          onChange={(event) => {
            const rounds = Math.round(Number(event.target.value))
            onChange({ ...iterate, maxRounds: Math.max(1, Math.min(MAX_ROUNDS, rounds || 1)) })
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          Run again while
        </span>
        <button
          type="button"
          onClick={() => onChange({ ...iterate, continueWhile: [...checks, defaultPredicate(nodeId)] })}
          className="flex h-8 items-center gap-1 rounded-[9px] px-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
        >
          <Plus size={12} aria-hidden /> Add
        </button>
      </div>
      {checks.map((check, index) => (
        <CheckRow
          key={index}
          nodeId={nodeId}
          check={check}
          onChange={(next) => patch(index, next)}
          onRemove={() => onChange({ ...iterate, continueWhile: checks.filter((_, i) => i !== index) })}
        />
      ))}
    </>
  )
}

export function IterateSection({ nodeId, config, update }: {
  nodeId: string
  config: CallConfig
  update: (config: CallConfig) => void
}) {
  const iterate = config.iterate
  /** Absent means absent: turning the loop off deletes the key rather than
   *  leaving an empty block the schema would still read as "this iterates". */
  const onChange = (next: IterateWire | undefined) => {
    const { iterate: _cleared, ...rest } = config
    update(next ? { ...rest, iterate: next } : rest)
  }
  const checks = iterate?.continueWhile ?? []
  const patch = (index: number, next: PredicateWire) =>
    onChange({ ...iterate, continueWhile: checks.map((check, i) => (i === index ? next : check)) })

  return (
    <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3">
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <label htmlFor="call-iterate" className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          Repeat until done
        </label>
        <Switch
          id="call-iterate"
          checked={iterate !== undefined}
          onCheckedChange={(next) => onChange(next ? { maxRounds: 2, continueWhile: [defaultPredicate(nodeId)] } : undefined)}
        />
      </div>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        {iterate
          ? "Each round is its own child run. Wire the exhausted handle so a loop that spends every round still has somewhere to go."
          : "Off: this calls the target once. On: it calls it again while the round that just finished still asks for another."}
      </p>
      {iterate && (
        <LoopFields nodeId={nodeId} iterate={iterate} onChange={onChange} checks={checks} patch={patch} />
      )}
    </section>
  )
}
