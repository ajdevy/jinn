import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { WorkflowOutputSchemaWire } from "@/lib/api"
import { Field, PickerField, TextInput } from "./inspector-fields"
import type { WorkflowNodeOfType } from "./ports"

type EmployeeConfig = WorkflowNodeOfType<"employee">["config"]
type OutputField = WorkflowOutputSchemaWire["fields"][string]
type OutputFieldType = OutputField["type"]

const OUTPUT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/
const OUTPUT_FIELD_TYPES: OutputFieldType[] = ["string", "number", "boolean", "string[]"]

const isOutputFieldType = (value: string): value is OutputFieldType =>
  OUTPUT_FIELD_TYPES.some((type) => type === value)

const SECTION = "rounded-[var(--radius-lg)] border border-[var(--separator)] p-3"
const HEADING = "text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
const REMOVE_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"

/** The name is edited as a draft: an invalid or colliding name stays on screen
 *  with its reason rather than being rejected keystroke by keystroke, and is
 *  committed upward only once it is usable. */
function useDraftFieldName(name: string, existingNames: string[], onRename: (name: string) => void) {
  const [draftName, setDraftName] = useState(name)
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => setDraftName(name), [name])

  const changeName = (next: string) => {
    setDraftName(next)
    if (!OUTPUT_FIELD_NAME.test(next)) {
      setNameError("Use letters, numbers, underscores, or hyphens; start with a letter or underscore.")
      return
    }
    if (next !== name && existingNames.includes(next)) {
      setNameError("Use a unique field name.")
      return
    }
    setNameError(null)
    if (next !== name) onRename(next)
  }

  return { draftName, nameError, changeName }
}

function FieldNameRow({
  index, name, existingNames, onRename, onRemove,
}: {
  index: number
  name: string
  existingNames: string[]
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const { draftName, nameError, changeName } = useDraftFieldName(name, existingNames, onRename)
  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <TextInput
          aria-label={`Output field ${index + 1} name`}
          value={draftName}
          onChange={(event) => changeName(event.target.value)}
          placeholder="result"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `output-field-${index}-error` : undefined}
          style={{ fontFamily: "var(--font-code)" }}
        />
        {nameError && (
          <p id={`output-field-${index}-error`} className="mt-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
            {nameError}
          </p>
        )}
      </div>
      <button type="button" aria-label={`Remove output field ${name}`} onClick={onRemove} className={REMOVE_BUTTON}>
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  )
}

/** Both rows below edit one field of the schema in place. */
interface FieldRowProps {
  index: number
  field: OutputField
  onChange: (field: OutputField) => void
}

function FieldTypeRow({ index, field, onChange }: FieldRowProps) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
      <PickerField
        label="Type"
        value={field.type}
        onChange={(type) => { if (isOutputFieldType(type)) onChange({ ...field, type }) }}
        options={OUTPUT_FIELD_TYPES.map((type) => ({ value: type, label: type }))}
      />
      <label className="flex h-8 items-center gap-1.5 px-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          aria-label={`Output field ${index + 1} required`}
          checked={field.required}
          onChange={(event) => onChange({ ...field, required: event.target.checked })}
          className="size-4 accent-[var(--accent)]"
        />
        Required
      </label>
    </div>
  )
}

function FieldDescription({ index, field, onChange }: FieldRowProps) {
  return (
    <Field label="Description">
      <TextInput
        aria-label={`Output field ${index + 1} description`}
        value={field.description ?? ""}
        onChange={(event) => {
          const description = event.target.value
          const next = { ...field }
          if (description) next.description = description
          else delete next.description
          onChange(next)
        }}
        placeholder="What this field contains"
      />
    </Field>
  )
}

function OutputFieldRow(props: FieldRowProps & {
  name: string
  existingNames: string[]
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const { index, field, onChange } = props
  return (
    <div className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-2.5">
      <FieldNameRow {...props} />
      <FieldTypeRow index={index} field={field} onChange={onChange} />
      <FieldDescription index={index} field={field} onChange={onChange} />
    </div>
  )
}

function NoOutputSchema({ onEnable }: { onEnable: () => void }) {
  return (
    <section className={SECTION}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className={HEADING}>Output</h3>
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">No structured output</p>
        </div>
        <button
          type="button"
          onClick={onEnable}
          className="h-8 rounded-[9px] bg-[var(--fill-tertiary)] px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        >
          Enable structured output
        </button>
      </div>
    </section>
  )
}

function OutputSchemaFooter({
  output, onAdd, onChange,
}: {
  output: WorkflowOutputSchemaWire
  onAdd: () => void
  onChange: (output: WorkflowOutputSchemaWire) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onAdd}
        className="flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
      >
        <Plus size={13} aria-hidden /> Add field
      </button>
      <label className="flex items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={output.allowAdditionalFields}
          onChange={(event) => onChange({ ...output, allowAdditionalFields: event.target.checked })}
          className="size-4 accent-[var(--accent)]"
        />
        Allow additional fields
      </label>
    </div>
  )
}

function OutputSchemaHeader({ onDisable }: { onDisable: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className={HEADING}>Output</h3>
      <button
        type="button"
        onClick={onDisable}
        className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] hover:text-[var(--system-red)]"
      >
        Disable structured output
      </button>
    </div>
  )
}

function OutputFieldList({
  output, onFields, onRemove,
}: {
  output: WorkflowOutputSchemaWire
  onFields: (fields: WorkflowOutputSchemaWire["fields"]) => void
  onRemove: (name: string) => void
}) {
  const entries = Object.entries(output.fields)
  return (
    <>
      {entries.map(([name, field], index) => (
        <OutputFieldRow
          key={name}
          index={index}
          name={name}
          field={field}
          existingNames={entries.map(([key]) => key)}
          onRename={(nextName) => onFields(
            Object.fromEntries(entries.map(([key, value]) => [key === name ? nextName : key, value])),
          )}
          onChange={(nextField) => onFields({ ...output.fields, [name]: nextField })}
          onRemove={() => onRemove(name)}
        />
      ))}
    </>
  )
}

function nextFieldName(fields: WorkflowOutputSchemaWire["fields"]): string {
  let name = "field"
  let suffix = 2
  while (Object.hasOwn(fields, name)) {
    name = `field_${suffix}`
    suffix += 1
  }
  return name
}

/** The structured-output contract an Employee node declares. Optional: a node
 *  with no `output` key returns free text, which is why disabling deletes the
 *  key rather than writing an empty schema. */
export function OutputSchemaForm({
  config, update,
}: {
  config: EmployeeConfig
  update: (config: EmployeeConfig) => void
}) {
  const output = config.output

  const disable = () => {
    const next = { ...config }
    delete next.output
    update(next)
  }

  if (!output) {
    return (
      <NoOutputSchema
        onEnable={() => update({
          ...config,
          output: { fields: { result: { type: "string", required: false } }, allowAdditionalFields: false },
        })}
      />
    )
  }

  const entries = Object.entries(output.fields)
  const setOutput = (next: WorkflowOutputSchemaWire) => update({ ...config, output: next })
  const withFields = (fields: WorkflowOutputSchemaWire["fields"]) => setOutput({ ...output, fields })
  const removeField = (name: string) => {
    const fields = Object.fromEntries(entries.filter(([key]) => key !== name))
    if (Object.keys(fields).length === 0) disable()
    else withFields(fields)
  }

  return (
    <section className={`space-y-2.5 ${SECTION}`}>
      <OutputSchemaHeader onDisable={disable} />
      <OutputFieldList output={output} onFields={withFields} onRemove={removeField} />
      <OutputSchemaFooter
        output={output}
        onAdd={() => withFields({ ...output.fields, [nextFieldName(output.fields)]: { type: "string", required: false } })}
        onChange={setOutput}
      />
    </section>
  )
}
