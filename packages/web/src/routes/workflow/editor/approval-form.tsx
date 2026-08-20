import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Field, TextInput, fixedText, type FormProps } from "./inspector-fields"
import type { WorkflowNodeOfType } from "./ports"

type ApprovalConfig = WorkflowNodeOfType<"approval">["config"]

// The gateway takes 2-8 unique labels of at most 80 characters. An invalid
// label stays in the row it was typed into and never reaches the config, so
// what the editor saves is valid at every keystroke rather than only on save.
const MIN_CHOICES = 2
const MAX_CHOICES = 8
const MAX_CHOICE_LENGTH = 80

function storedChoices(config: ApprovalConfig): string[] | null {
  return config.options ?? null
}

/** Empty clears the binding: an approver the schema never sees beats one it
 *  would reject for being blank. */
function withApprover(config: ApprovalConfig, value: string): ApprovalConfig {
  const next = { ...config }
  if (value) next.approver = { source: "fixed", value }
  else delete next.approver
  return next
}

/* The gateway trims every label before it validates them, so " A " and "A" are
   the same label to it. Compare trimmed or the editor calls a duplicate unique
   and the save the operator never doubted comes back rejected. */
function choiceError(value: string, siblings: string[]): string | null {
  const label = value.trim()
  if (!label) return "Give every choice a label."
  if (label.length > MAX_CHOICE_LENGTH) return `Keep a choice to ${MAX_CHOICE_LENGTH} characters or fewer.`
  if (siblings.some((sibling) => sibling.trim() === label)) return "Use a unique label."
  return null
}

function ChoiceRow({ index, value, siblings, onChange, onRemove, removable }: {
  index: number
  value: string
  siblings: string[]
  onChange: (value: string) => void
  onRemove: () => void
  removable: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)

  // Keeps a trailing space from being swallowed mid-word by the trimmed commit.
  useEffect(() => setDraft((current) => (current.trim() === value ? current : value)), [value])

  const change = (next: string) => {
    setDraft(next)
    const message = choiceError(next, siblings)
    setError(message)
    if (!message) onChange(next.trim())
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <TextInput
          className="min-h-[34px]"
          aria-label={`Choice ${index + 1}`}
          value={draft}
          onChange={(event) => change(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `approval-choice-${index}-error` : undefined}
        />
        <button
          type="button"
          aria-label={`Remove choice ${index + 1}`}
          disabled={!removable}
          onClick={onRemove}
          className="grid size-[34px] shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)] disabled:pointer-events-none disabled:text-[var(--text-quaternary)]"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
      {error && (
        <p id={`approval-choice-${index}-error`} className="mt-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
          {error}
        </p>
      )}
    </div>
  )
}

function ChoiceList({ choices, setChoices }: { choices: string[]; setChoices: (next: string[]) => void }) {
  const addChoice = () => {
    let suffix = choices.length + 1
    while (choices.includes(`Option ${suffix}`)) suffix += 1
    setChoices([...choices, `Option ${suffix}`])
  }
  return (
    <>
      {choices.map((choice, index) => (
        <ChoiceRow
          key={index}
          index={index}
          value={choice}
          siblings={choices.filter((_, other) => other !== index)}
          onChange={(next) => setChoices(choices.map((current, other) => (other === index ? next : current)))}
          onRemove={() => setChoices(choices.filter((_, other) => other !== index))}
          removable={choices.length > MIN_CHOICES}
        />
      ))}
      <button
        type="button"
        onClick={addChoice}
        disabled={choices.length >= MAX_CHOICES}
        className="flex h-[34px] items-center gap-1.5 rounded-[9px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] disabled:pointer-events-none disabled:text-[var(--text-quaternary)]"
      >
        <Plus size={13} aria-hidden /> Add choice
      </button>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Between {MIN_CHOICES} and {MAX_CHOICES} labels. Whichever is picked reads back as this node’s choice.
      </p>
    </>
  )
}

function ChoicesSection({ config, update }: {
  config: ApprovalConfig
  update: (config: ApprovalConfig) => void
}) {
  const choices = storedChoices(config)
  return (
    <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-3">
      {/* The whole row is the label, so the tap target clears 34px even though the
          switch track itself is only 20px tall. */}
      <label
        htmlFor="approval-fixed-choices"
        className="flex min-h-[34px] cursor-pointer items-center justify-between gap-[var(--space-3)]"
      >
        <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          Offer fixed choices
        </span>
        <Switch
          id="approval-fixed-choices"
          checked={choices !== null}
          onCheckedChange={(next) => {
            const { options: _options, ...rest } = config
            update(next ? { ...rest, options: ["Option 1", "Option 2"] } : rest)
          }}
        />
      </label>
      {choices === null ? (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Approved or rejected, with no labelled alternatives to pick between.
        </p>
      ) : (
        <ChoiceList choices={choices} setChoices={(next) => update({ ...config, options: next })} />
      )}
    </section>
  )
}

export function ApprovalForm({ node, update }: FormProps<WorkflowNodeOfType<"approval">>) {
  const config = node.config
  const set = (next: ApprovalConfig) => update({ ...node, config: next })
  const operatorOnly = config.operatorOnly === true
  return (
    <>
      <Field label="What needs approval?">
        <Textarea
          rows={3}
          value={config.description}
          onChange={(event) => set({ ...config, description: event.target.value })}
          placeholder="Describe the decision"
        />
      </Field>
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <label
          htmlFor="approval-operator-only"
          className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
        >
          Only the operator may decide
        </label>
        <Switch
          id="approval-operator-only"
          checked={operatorOnly}
          // Mutually exclusive with an approver: naming one would contradict
          // reserving the gate, and the definition schema refuses both together.
          onCheckedChange={(next) => {
            const { approver: _approver, operatorOnly: _operatorOnly, ...rest } = config
            set(next ? { ...rest, operatorOnly: true } : rest)
          }}
        />
      </div>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        {operatorOnly
          ? "Reserved for the human operator. No employee can decide it, not even the COO, and escalating it does not open it up."
          : "Otherwise this routes up the org hierarchy, so the COO can decide it."}
      </p>
      {!operatorOnly && (
        <Field label="Approver (optional)">
          <TextInput
            value={fixedText(config.approver)}
            onChange={(event) => set(withApprover(config, event.target.value))}
            placeholder="Employee who decides"
          />
        </Field>
      )}
      <ChoicesSection config={config} update={set} />
    </>
  )
}
