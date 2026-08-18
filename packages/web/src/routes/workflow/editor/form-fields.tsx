import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkflowNodeWire } from "./ports"

/* ── tiny form primitives (Ledger-styled, matching ui/textarea) ───────────── */

export interface FormProps {
  node: WorkflowNodeWire
  update: (config: Record<string, unknown>) => void
}

export function TextInput(props: React.ComponentProps<"input">) {
  const { className = "", ...rest } = props
  return (
    <input
      {...rest}
      className={`h-8 w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] ${className}`}
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
        <SelectTrigger aria-label={label}>
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
