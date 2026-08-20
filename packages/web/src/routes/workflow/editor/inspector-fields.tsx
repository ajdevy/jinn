import type { JsonValueWire, WorkflowBindingWire } from "@/lib/api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fixedBinding, type StringBinding, type WorkflowNodeWire } from "./ports"

/* ── tiny form primitives (Ledger-styled) ─────────────────────────────────── */

/* Editor fields separate by fill, not by a hairline: no resting border, a fill one
   step up from the panel so the field still reads, and focus carried by the ring.
   34px is the floor every inspector field shares, so 390px stays tappable. */
export function TextInput(props: React.ComponentProps<"input">) {
  const { className = "", ...rest } = props
  return (
    <input
      {...rest}
      className={`h-[34px] w-full rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${className}`}
    />
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
        {label}
      </span>
      {children}
    </label>
  )
}

const TRIGGER_CLASS = "min-h-[34px] border-0 bg-[var(--fill-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"

export function PickerField({
  label, value, onChange, options, placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string; disabled?: boolean }>
  placeholder?: string
}) {
  return (
    <Field label={label}>
      {/* "" is a controlled empty selection — `|| undefined` would flip the
          Select uncontrolled→controlled on first pick and warn. */}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className={TRIGGER_CLASS}>
          <SelectValue placeholder={placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export const CLEAR = "__none__"

/* ── binding helpers: plain text ⇄ fixed bindings ─────────────────────────── */

/** The picker's text for a binding: the literal someone typed, or empty when the
 *  binding points at run data and there is nothing to show in a text box. */
export function fixedText(binding: StringBinding | undefined): string {
  return (binding && fixedBinding(binding)) ?? ""
}

/** Fixed predicate values coerce sensibly: true/false → boolean, numerics → number. */
export function parseFixedValue(text: string): JsonValueWire {
  if (text === "true") return true
  if (text === "false") return false
  if (text.trim() !== "" && Number.isFinite(Number(text))) return Number(text)
  return text
}

export function parseJsonFixedValue(text: string): JsonValueWire {
  try {
    return JSON.parse(text) as JsonValueWire
  } catch {
    return text
  }
}

export function fixedValueText(value: WorkflowBindingWire<JsonValueWire> | undefined): string {
  if (value?.source !== "fixed") return ""
  return typeof value.value === "string" ? value.value : JSON.stringify(value.value ?? "")
}

export interface FormProps<N extends WorkflowNodeWire = WorkflowNodeWire> {
  node: N
  /** Takes the whole edited node rather than a bare config: `type` and `config`
   *  are one choice in the schema, and only moving them together stops a config
   *  being written onto an arm it does not belong to. */
  update: (node: N) => void
}
