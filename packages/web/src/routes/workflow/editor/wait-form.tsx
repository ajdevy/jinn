import { useEffect, useId, useState } from "react"
import { Field, PickerField, TextInput, fixedText, type FormProps } from "./inspector-fields"
import type { WorkflowNodeOfType } from "./ports"

type WaitConfig = WorkflowNodeOfType<"wait">["config"]

const MIN_MINUTES = 1
const MAX_MINUTES = 43_200
/** The gateway's own default for a Todo-comment wait: a conversation on a Todo
 *  gets a working week to happen in. */
const TODO_COMMENT_MINUTES = 10_080

const WAIT_MODES = [
  { value: "duration", label: "For a duration" },
  { value: "until", label: "Until a timestamp" },
  { value: "todo-comment", label: "Until a Todo comment" },
]

function defaultWaitConfig(mode: string): WaitConfig {
  switch (mode) {
    case "until": return { mode: "until", timestamp: { source: "fixed", value: "" } }
    case "todo-comment": return { mode: "todo-comment", timeoutMinutes: TODO_COMMENT_MINUTES }
    default: return { mode: "duration", minutes: 60 }
  }
}

/* Both wait minutes share the gateway's 1..43200 range. Clamping an out-of-range
   entry to the nearest legal value saves a number nobody typed, so an invalid
   entry stays in the field and says why instead of reaching the config. */
function minutesError(raw: string): string | null {
  if (!raw.trim()) return "Enter a number of minutes."
  const minutes = Number(raw)
  if (!Number.isInteger(minutes)) return "Enter a whole number of minutes."
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return `Enter between ${MIN_MINUTES} and ${MAX_MINUTES} minutes.`
  }
  return null
}

function MinutesField({ label, value, onChange }: {
  label: string
  value: unknown
  onChange: (minutes: number) => void
}) {
  const stored = typeof value === "number" ? String(value) : ""
  const [draft, setDraft] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  // Only follow the config when it moved somewhere the field is not already.
  useEffect(() => setDraft((current) => (Number(current) === value ? current : stored)), [value, stored])

  const change = (next: string) => {
    setDraft(next)
    const message = minutesError(next)
    setError(message)
    if (!message) onChange(Number(next))
  }

  return (
    <div>
      <Field label={label}>
        <TextInput
          className="min-h-[34px]"
          type="number"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          value={draft}
          onChange={(event) => change(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </Field>
      {error && (
        <p id={errorId} className="mt-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
          {error}
        </p>
      )}
    </div>
  )
}

function TodoCommentFields({ minutes, onChange }: { minutes: unknown; onChange: (minutes: number) => void }) {
  return (
    <>
      <MinutesField label="Timeout (minutes)" value={minutes} onChange={onChange} />
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Resumes as soon as you comment on the run’s Todo. The timeout is the ceiling, not a schedule.
      </p>
    </>
  )
}

export function WaitForm({ node, update }: FormProps<WorkflowNodeOfType<"wait">>) {
  const config = node.config
  const set = (next: WaitConfig) => update({ ...node, config: next })
  // Read-only for any other mode on purpose: every control below writes a whole
  // new config, so a mode this form cannot render would be downgraded into a
  // duration on first touch. Handling a mode is what earns it controls.
  if (!WAIT_MODES.some((waitMode) => waitMode.value === config.mode)) {
    return (
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        This wait runs in “{typeof config.mode === "string" ? config.mode : "no"}” mode, which this editor does not
        know. It stays exactly as authored — change it through the workflow API.
      </p>
    )
  }
  return (
    <>
      <PickerField
        label="Wait"
        value={config.mode}
        onChange={(next) => set(defaultWaitConfig(next))}
        options={WAIT_MODES}
      />
      {config.mode === "duration" && (
        <MinutesField
          label="Minutes"
          value={config.minutes}
          onChange={(minutes) => set({ mode: "duration", minutes })}
        />
      )}
      {config.mode === "until" && (
        <Field label="Timestamp (ISO)">
          <TextInput
            value={fixedText(config.timestamp)}
            onChange={(event) => set({ mode: "until", timestamp: { source: "fixed", value: event.target.value } })}
            placeholder="2026-08-01T09:00:00Z"
            style={{ fontFamily: "var(--font-code)" }}
          />
        </Field>
      )}
      {config.mode === "todo-comment" && (
        <TodoCommentFields
          minutes={config.timeoutMinutes}
          onChange={(timeoutMinutes) => set({ mode: "todo-comment", timeoutMinutes })}
        />
      )}
    </>
  )
}
