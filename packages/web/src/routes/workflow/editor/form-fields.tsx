import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkflowNodeWire } from "./ports"

/* ── tiny form primitives (Ledger-styled) ─────────────────────────────────── */

export interface FormProps {
  node: WorkflowNodeWire
  update: (config: Record<string, unknown>) => void
}

/* Editor fields separate by fill, not by a hairline: no resting border, a fill one
   step up from the panel so the field still reads, and focus carried by the ring. */
export function TextInput(props: React.ComponentProps<"input">) {
  const { className = "", ...rest } = props
  return (
    <input
      {...rest}
      className={`h-8 w-full rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${className}`}
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

const TRIGGER_CLASS = "border-0 bg-[var(--fill-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"

export function PickerField({
  label, value, onChange, options, placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
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
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
