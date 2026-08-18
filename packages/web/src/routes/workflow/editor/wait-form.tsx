import { fixedText } from "./bindings"
import { Field, PickerField, TextInput, type FormProps } from "./form-fields"

const MAX_MINUTES = 43_200
/** The gateway's own default for a Todo-comment wait: a conversation on a Todo
 *  gets a working week to happen in. */
const TODO_COMMENT_MINUTES = 10_080

const WAIT_MODES = [
  { value: "duration", label: "For a duration" },
  { value: "until", label: "Until a timestamp" },
  { value: "todo-comment", label: "Until a Todo comment" },
]

function defaultWaitConfig(mode: string): Record<string, unknown> {
  switch (mode) {
    case "until": return { mode: "until", timestamp: { source: "fixed", value: "" } }
    case "todo-comment": return { mode: "todo-comment", timeoutMinutes: TODO_COMMENT_MINUTES }
    default: return { mode: "duration", minutes: 60 }
  }
}

/** Both wait minutes share the gateway's 1..43200 range, so an out-of-range or
 *  half-typed entry lands on the nearest value the schema takes. */
function MinutesField({ label, value, fallback, onChange }: {
  label: string
  value: unknown
  fallback: number
  onChange: (minutes: number) => void
}) {
  return (
    <Field label={label}>
      <TextInput
        className="min-h-[34px]"
        type="number"
        min={1}
        max={MAX_MINUTES}
        value={typeof value === "number" ? String(value) : ""}
        onChange={(event) => onChange(
          Math.max(1, Math.min(MAX_MINUTES, Math.round(Number(event.target.value)) || fallback)),
        )}
      />
    </Field>
  )
}

function TodoCommentFields({ minutes, onChange }: { minutes: unknown; onChange: (minutes: number) => void }) {
  return (
    <>
      <MinutesField label="Timeout (minutes)" value={minutes} fallback={TODO_COMMENT_MINUTES} onChange={onChange} />
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Resumes as soon as you comment on the run’s Todo. The timeout is the ceiling, not a schedule.
      </p>
    </>
  )
}

export function WaitForm({ node, update }: FormProps) {
  const config = node.config as { mode?: string; minutes?: number; timeoutMinutes?: number; timestamp?: unknown }
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
        value={config.mode ?? "duration"}
        onChange={(next) => update(defaultWaitConfig(next))}
        options={WAIT_MODES}
      />
      {config.mode === "duration" && (
        <MinutesField
          label="Minutes"
          value={config.minutes}
          fallback={1}
          onChange={(minutes) => update({ mode: "duration", minutes })}
        />
      )}
      {config.mode === "until" && (
        <Field label="Timestamp (ISO)">
          <TextInput
            value={fixedText(config.timestamp)}
            onChange={(event) => update({ mode: "until", timestamp: { source: "fixed", value: event.target.value } })}
            placeholder="2026-08-01T09:00:00Z"
            style={{ fontFamily: "var(--font-code)" }}
          />
        </Field>
      )}
      {config.mode === "todo-comment" && (
        <TodoCommentFields
          minutes={config.timeoutMinutes}
          onChange={(timeoutMinutes) => update({ mode: "todo-comment", timeoutMinutes })}
        />
      )}
    </>
  )
}
