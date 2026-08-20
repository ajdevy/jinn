import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useShallow } from "zustand/react/shallow"
import { Plus, Trash2, X } from "lucide-react"
import { api } from "@/lib/api"
import type { JsonValueWire, WorkflowBindingWire, WorkflowPredicateWire } from "@/lib/api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ApprovalForm } from "./approval-form"
import { allocateConditionPort } from "./graph"
import { CLEAR, Field, PickerField, TextInput, fixedText, type FormProps } from "./inspector-fields"
import { NodeTypeIcon } from "./node-icons"
import { OutputSchemaForm } from "./output-schema-form"
import { NODE_TYPE_LABEL, type WorkflowNodeOfType, type WorkflowNodeWire } from "./ports"
import { useEditor } from "./store"
import { WaitForm } from "./wait-form"

function FilterPicker({
  label, value, onChange, options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  const optionsWithStoredValue = value && !options.some((option) => option.value === value)
    ? [{ value, label: value }, ...options]
    : options
  return (
    <PickerField
      label={label}
      value={value || CLEAR}
      onChange={(next) => onChange(next === CLEAR ? "" : next)}
      options={[
        { value: CLEAR, label: `Any ${label.toLowerCase()}` },
        ...optionsWithStoredValue,
      ]}
    />
  )
}


/** Fixed predicate values coerce sensibly: true/false → boolean, numerics → number. */
function parseFixedValue(text: string): JsonValueWire {
  if (text === "true") return true
  if (text === "false") return false
  if (text.trim() !== "" && Number.isFinite(Number(text))) return Number(text)
  return text
}

function parseJsonFixedValue(text: string): JsonValueWire {
  try {
    return JSON.parse(text) as JsonValueWire
  } catch {
    return text
  }
}

function fixedValueText(value: WorkflowBindingWire<JsonValueWire> | undefined): string {
  if (value?.source !== "fixed") return ""
  return typeof value.value === "string" ? value.value : JSON.stringify(value.value ?? "")
}

/* ── per-type forms ───────────────────────────────────────────────────────── */
type TriggerConfig = WorkflowNodeOfType<"trigger">["config"]
type TriggerKind = TriggerConfig["kind"]
type TodoStatusTrigger = Extract<TriggerConfig, { kind: "todo-status" }>

const TRIGGER_KINDS: Array<{ value: TriggerKind; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "schedule", label: "Schedule" },
  { value: "event", label: "Event" },
  { value: "todo-status", label: "Todo status" },
  { value: "workflow-call", label: "Workflow call" },
]

const TODO_STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]

const isTriggerKind = (value: string): value is TriggerKind =>
  TRIGGER_KINDS.some((option) => option.value === value)

function defaultTriggerConfig(kind: TriggerKind): TriggerConfig {
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }
    case "event": return { kind, eventName: "event" }
    case "todo-status": return { kind, status: "in_review" }
    case "manual": return { kind }
    case "workflow-call": return { kind }
  }
}

/** An empty filter means "match any Todo", which the schema spells as an absent
 *  key rather than an empty string. */
function withOptionalFilter(
  config: TodoStatusTrigger,
  key: "label" | "department" | "assignee" | "actor",
  value: string,
): TodoStatusTrigger {
  const next = { ...config }
  if (value) next[key] = value
  else delete next[key]
  return next
}

function TriggerForm({ node, update }: FormProps<WorkflowNodeOfType<"trigger">>) {
  const config = node.config
  const kind = config.kind
  const set = (next: TriggerConfig) => update({ ...node, config: next })
  const labels = useQuery({
    queryKey: ["labels"],
    queryFn: async () => (await api.listLabels()).labels,
    staleTime: 60_000,
    enabled: kind === "todo-status",
  })
  const org = useQuery({
    queryKey: ["org"],
    queryFn: api.getOrg,
    staleTime: 60_000,
    enabled: kind === "todo-status",
  })
  return (
    <>
      <PickerField
        label="Fires on"
        value={kind}
        onChange={(next) => { if (isTriggerKind(next)) set(defaultTriggerConfig(next)) }}
        options={TRIGGER_KINDS}
      />
      {config.kind === "schedule" && (
        <>
          <Field label="Cron">
            <TextInput
              value={config.cron}
              onChange={(event) => set({ ...config, cron: event.target.value })}
              placeholder="0 9 * * *"
              style={{ fontFamily: "var(--font-code)" }}
            />
          </Field>
          <Field label="Timezone">
            <TextInput
              value={config.timezone}
              onChange={(event) => set({ ...config, timezone: event.target.value })}
              placeholder="Europe/Sofia"
            />
          </Field>
        </>
      )}
      {config.kind === "event" && (
        <Field label="Event name">
          <TextInput
            value={config.eventName}
            onChange={(event) => set({ ...config, eventName: event.target.value })}
            placeholder="deploy-finished"
          />
        </Field>
      )}
      {config.kind === "todo-status" && (
        <>
          <PickerField
            label="Todo moves to"
            value={config.status}
            onChange={(next) => set({ ...config, status: next })}
            options={TODO_STATUSES.map((status) => ({ value: status, label: status }))}
          />
          <section className="space-y-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-3">
            <div>
              <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                Only when
              </h3>
              <p className="mt-0.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                Empty fields match any Todo.
              </p>
            </div>
            <FilterPicker
              label="Label"
              value={config.label ?? ""}
              onChange={(value) => set(withOptionalFilter(config, "label", value))}
              options={(labels.data ?? []).map((label) => ({ value: label.name, label: label.name }))}
            />
            <FilterPicker
              label="Department"
              value={config.department ?? ""}
              onChange={(value) => set(withOptionalFilter(config, "department", value))}
              options={(org.data?.departments ?? []).map((department) => ({ value: department, label: department }))}
            />
            <div>
              <FilterPicker
                label="Assignee"
                value={config.assignee ?? ""}
                onChange={(value) => set(withOptionalFilter(config, "assignee", value))}
                options={(org.data?.employees ?? []).map((employee) => ({ value: employee.name, label: employee.name }))}
              />
              <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                Moving a Todo to “assigned” does not assign it. An unassigned Todo never matches.
              </p>
            </div>
            <Field label="Actor">
              <TextInput
                className="min-h-[34px]"
                value={config.actor ?? ""}
                onChange={(event) => set(withOptionalFilter(config, "actor", event.target.value))}
                placeholder="operator"
              />
            </Field>
          </section>
        </>
      )}
    </>
  )
}

type EmployeeConfig = WorkflowNodeOfType<"employee">["config"]
type Effort = Extract<NonNullable<EmployeeConfig["effort"]>, { source: "fixed" }>["value"]

const EFFORTS = ["low", "medium", "high", "xhigh"] as const satisfies readonly Effort[]

/** "Default" clears the binding; every other choice is one of `EFFORTS`. */
function withEffort(config: EmployeeConfig, choice: string): EmployeeConfig {
  const next = { ...config }
  delete next.effort
  const effort = EFFORTS.find((value) => value === choice)
  return effort === undefined ? next : { ...next, effort: { source: "fixed", value: effort } }
}
const CUSTOM = "__custom__"

function EmployeeForm({ node, update }: FormProps<WorkflowNodeOfType<"employee">>) {
  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg, staleTime: 60_000 })
  const config = node.config
  const employees = org.data?.employees ?? []
  const set = (next: EmployeeConfig) => update({ ...node, config: next })
  return (
    <>
      <PickerField
        label="Employee"
        value={fixedText(config.employee)}
        onChange={(next) => set({ ...config, employee: { source: "fixed", value: next } })}
        options={employees.map((employee) => ({ value: employee.name, label: employee.name }))}
        placeholder={org.isPending ? "Loading…" : "Choose employee"}
      />
      <Field label="Prompt">
        <Textarea
          rows={6}
          value={config.prompt}
          onChange={(event) => set({ ...config, prompt: event.target.value })}
          placeholder="What should this employee do?"
        />
      </Field>
      <PickerField
        label="Effort"
        value={fixedText(config.effort) || CLEAR}
        onChange={(next) => set(withEffort(config, next))}
        options={[{ value: CLEAR, label: "Default" }, ...EFFORTS.map((value) => ({ value, label: value }))]}
      />
      <OutputSchemaForm config={config} update={set} />
      <section className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
        <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Advanced</h3>
        <PickerField
          label="Fallback"
          value={Array.isArray(config.fallback) ? CUSTOM : config.fallback === "none" ? "none" : "inherit"}
          // A chain is only ever picked back to one of the two literals; CUSTOM is
          // shown disabled, so `next` can be nothing else.
          onChange={(next) => { if (next === "inherit" || next === "none") set({ ...config, fallback: next }) }}
          // A chain authored as JSON is shown so picking here cannot silently discard it, and is unpickable because this select cannot author one.
          options={[{ value: "inherit", label: "Inherit" }, { value: "none", label: "None" },
            ...(Array.isArray(config.fallback) ? [{ value: CUSTOM, label: config.fallback.join(" → "), disabled: true }] : [])]}
        />
        <Field label="Timeout (minutes)">
          <TextInput
            type="number"
            min={1}
            max={1440}
            step={1}
            value={config.timeoutMinutes === undefined ? "" : String(config.timeoutMinutes)}
            onChange={(event) => {
              const next = { ...config }
              if (event.target.value === "") {
                delete next.timeoutMinutes
              } else {
                next.timeoutMinutes = Math.max(1, Math.min(1440, Math.round(Number(event.target.value))))
              }
              set(next)
            }}
            placeholder="No hard timeout"
          />
        </Field>
      </section>
    </>
  )
}

type WorkflowCallConfig = WorkflowNodeOfType<"workflow-call">["config"]
type ConditionConfig = WorkflowNodeOfType<"condition">["config"]
type ConditionCase = ConditionConfig["cases"][number]
type Operator = WorkflowPredicateWire["operator"]

const OPERATORS: Operator[] = ["equals", "not-equals", "exists", "not-exists", "contains", "gt", "gte", "lt", "lte", "in"]

const isOperator = (value: string): value is Operator => OPERATORS.some((operator) => operator === value)
const SOURCES = [
  { value: "node", label: "Node output" },
  { value: "trigger", label: "Trigger" },
  { value: "input", label: "Run input" },
  { value: "run", label: "Run" },
  { value: "fixed", label: "Fixed value" },
]

function BindingEditor<T extends JsonValueWire>({
  value, onChange, nodeIds, fixedParser,
}: {
  value: WorkflowBindingWire<T>
  onChange: (next: WorkflowBindingWire<T>) => void
  nodeIds: string[]
  /** Reads the typed-in text as the value this particular binding holds — the
   *  same function supplies the empty starting value when a person switches
   *  the source to "fixed". */
  fixedParser: (text: string) => T
}) {
  const path = value.source === "fixed" ? "" : value.path
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
      <Select value={value.source} onValueChange={(next) => {
        if (next === "fixed") onChange({ source: "fixed", value: fixedParser("") })
        else if (next === "node") onChange({ source: "node", nodeId: nodeIds[0] ?? "", path: "text" })
        else if (next === "input" || next === "trigger" || next === "run") onChange({ source: next, path: path || "payload" })
      }}>
        <SelectTrigger aria-label="Value source" className="h-8 w-auto min-w-[104px] flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SOURCES.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.source === "node" && (
        <Select
          value={value.nodeId}
          onValueChange={(next) => onChange({ ...value, nodeId: next })}
        >
          <SelectTrigger aria-label="Source node" className="h-8 w-auto min-w-[96px] flex-none">
            <SelectValue placeholder="node" />
          </SelectTrigger>
          <SelectContent>
            {nodeIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {value.source === "fixed" ? (
        <TextInput
          aria-label="Fixed value"
          value={fixedValueText(value)}
          onChange={(event) => onChange({ source: "fixed", value: fixedParser(event.target.value) })}
          placeholder="value"
          className="min-w-[80px] flex-1"
        />
      ) : (
        <TextInput
          aria-label="Path"
          value={value.path}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
          placeholder="fields.result"
          className="min-w-[80px] flex-1"
          style={{ fontFamily: "var(--font-code)" }}
        />
      )}
    </div>
  )
}

/** A written-in number and a `fixed` binding of it mean the same thing; the control shows one shape, so an authored planner binding survives being looked at. */
function concurrencyBinding(value: WorkflowCallConfig["concurrency"]): WorkflowBindingWire<number> {
  return typeof value === "number" ? { source: "fixed", value } : value
}

function WorkflowCallForm({ node, update }: FormProps<WorkflowNodeOfType<"workflow-call">>) {
  const nodeIds = useEditor(useShallow((state) => state.nodes.map((item) => item.id))).filter((id) => id !== node.id)
  const config = node.config
  const set = (next: WorkflowCallConfig) => update({ ...node, config: next })
  const input = config.input ?? {}
  const inputEntries = Object.entries(input)
  const setInput = (next: WorkflowCallConfig["input"] & object) => {
    const updated = { ...config }
    if (Object.keys(next).length > 0) updated.input = next
    else delete updated.input
    set(updated)
  }
  const addInput = () => {
    let name = "item"
    let suffix = 2
    while (Object.hasOwn(input, name)) {
      name = `item_${suffix}`
      suffix += 1
    }
    setInput({ ...input, [name]: { source: "trigger", path: "item" } })
  }

  return (
    <>
      <Field label="Workflow">
        <BindingEditor
          value={config.workflowId}
          onChange={(workflowId) => set({ ...config, workflowId })}
          nodeIds={nodeIds}
          fixedParser={(text) => text}
        />
      </Field>
      <Field label="Concurrency">
        <BindingEditor
          value={concurrencyBinding(config.concurrency)}
          onChange={(concurrency) => set({ ...config, concurrency })}
          nodeIds={nodeIds}
          fixedParser={(text) => Math.max(1, Math.min(16, Math.round(Number(text)) || 1))}
        />
      </Field>
      <section className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Items</h3>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Bind an array to start one child run per item. Leave empty for one run.
            </p>
          </div>
          {config.items ? (
            <button
              type="button"
              onClick={() => {
                const next = { ...config }
                delete next.items
                set(next)
              }}
              className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
              aria-label="Remove items binding"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => set({ ...config, items: { source: "trigger", path: "items" } })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-[9px] px-2 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
            >
              <Plus size={12} aria-hidden /> Bind
            </button>
          )}
        </div>
        {config.items && (
          <BindingEditor
            value={config.items}
            onChange={(items) => set({ ...config, items })}
            nodeIds={nodeIds}
            fixedParser={parseJsonFixedValue}
          />
        )}
      </section>
      <section className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--separator)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Child input</h3>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Map values into each child run.</p>
          </div>
          <button
            type="button"
            onClick={addInput}
            className="flex h-8 items-center gap-1 rounded-[9px] px-2 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
          >
            <Plus size={12} aria-hidden /> Add
          </button>
        </div>
        {inputEntries.map(([name, binding], index) => (
          <div key={name} className="space-y-1.5 rounded-[10px] bg-[var(--fill-quaternary)] p-2">
            <div className="flex items-center gap-1.5">
              <TextInput
                aria-label={`Child input ${index + 1} name`}
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value
                  if (!nextName || (nextName !== name && Object.hasOwn(input, nextName))) return
                  setInput(Object.fromEntries(inputEntries.map(([key, value]) => [key === name ? nextName : key, value])))
                }}
                className="flex-1"
                style={{ fontFamily: "var(--font-code)" }}
              />
              <button
                type="button"
                aria-label={`Remove child input ${name}`}
                onClick={() => setInput(Object.fromEntries(inputEntries.filter(([key]) => key !== name)))}
                className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            <BindingEditor
              value={binding}
              onChange={(next) => setInput({ ...input, [name]: next })}
              nodeIds={nodeIds}
              fixedParser={parseJsonFixedValue}
            />
          </div>
        ))}
      </section>
    </>
  )
}

function ConditionForm({ node, update }: FormProps<WorkflowNodeOfType<"condition">>) {
  // useShallow keeps the snapshot stable — a fresh array per getSnapshot call
  // loops useSyncExternalStore into React #185 and crashes the editor.
  const nodeIds = useEditor(useShallow((state) => state.nodes.map((item) => item.id))).filter((id) => id !== node.id)
  const config = node.config
  const cases = config.cases

  const setCases = (next: ConditionCase[]) => update({ ...node, config: { ...config, cases: next } })
  const patchCase = (index: number, patch: Partial<ConditionCase>) =>
    setCases(cases.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  return (
    <>
      {cases.map((item, index) => {
        const predicates = item.all
        return (
          <div key={item.port} className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <TextInput
                aria-label={`Route ${index + 1} label`}
                value={item.label}
                onChange={(event) => patchCase(index, { label: event.target.value })}
                placeholder={`Route ${index + 1}`}
                className="flex-1 bg-[var(--bg-secondary)]"
              />
              <button
                type="button"
                aria-label={`Remove route ${item.label || item.port}`}
                onClick={() => setCases(cases.filter((_, i) => i !== index))}
                className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            {predicates.map((predicate, predicateIndex) => (
              <div key={predicateIndex} className="mb-1.5 space-y-1">
                <div className="flex items-center gap-1">
                  <BindingEditor
                    value={predicate.left}
                    onChange={(left) => patchCase(index, {
                      all: predicates.map((p, i) => (i === predicateIndex ? { ...p, left } : p)),
                    })}
                    nodeIds={nodeIds}
                    fixedParser={parseFixedValue}
                  />
                  <button
                    type="button"
                    aria-label="Remove check"
                    onClick={() => patchCase(index, { all: predicates.filter((_, i) => i !== predicateIndex) })}
                    className="grid size-7 shrink-0 place-items-center rounded-[8px] text-[var(--text-quaternary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
                  >
                    <X size={13} aria-hidden />
                  </button>
                </div>
                <div className="flex gap-1">
                  <Select
                    value={predicate.operator}
                    onValueChange={(operator) => { if (isOperator(operator)) patchCase(index, {
                      all: predicates.map((p, i) => (i === predicateIndex ? { ...p, operator } : p)),
                    }) }}
                  >
                    <SelectTrigger aria-label="Operator" className="h-8 w-auto min-w-[104px] flex-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATORS.map((operator) => (
                        <SelectItem key={operator} value={operator}>{operator}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {predicate.operator !== "exists" && predicate.operator !== "not-exists" && (
                    <TextInput
                      aria-label="Compare to"
                      value={fixedValueText(predicate.right)}
                      onChange={(event) => patchCase(index, {
                        all: predicates.map((p, i) => (i === predicateIndex
                          ? { ...p, right: { source: "fixed", value: parseFixedValue(event.target.value) } }
                          : p)),
                      })}
                      placeholder="value"
                      className="flex-1"
                    />
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => patchCase(index, {
                all: [...predicates, { left: { source: "node", nodeId: nodeIds[0] ?? "", path: "text" }, operator: "equals", right: { source: "fixed", value: "" } }],
              })}
              className="flex h-7 items-center gap-1 rounded-[8px] px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
            >
              <Plus size={12} aria-hidden /> Add check
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => {
          const taken = new Set([...cases.map((item) => item.port), config.defaultPort ?? "else"])
          const port = allocateConditionPort(taken)
          setCases([...cases, { port, label: `Route ${cases.length + 1}`, all: [] }])
        }}
        className="flex h-8 items-center gap-1.5 rounded-[9px] px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
      >
        <Plus size={13} aria-hidden /> Add route
      </button>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Anything that matches no route takes the <span className="font-[var(--weight-semibold)]">else</span> path.
        A route with no checks always matches.
      </p>
    </>
  )
}

function EndForm({ node, update }: FormProps<WorkflowNodeOfType<"end">>) {
  const config = node.config
  const set = (next: WorkflowNodeOfType<"end">["config"]) => update({ ...node, config: next })
  return (
    <>
      <PickerField
        label="Result"
        value={config.result}
        onChange={(next) => { if (next === "success" || next === "failure") set({ ...config, result: next }) }}
        options={[{ value: "success", label: "Success" }, { value: "failure", label: "Failure" }]}
      />
      <Field label="Message (optional)">
        <TextInput
          value={config.message ?? ""}
          onChange={(event) => {
            const next = { ...config }
            if (event.target.value) next.message = event.target.value
            else delete next.message
            set(next)
          }}
          placeholder="Shown on the run"
        />
      </Field>
    </>
  )
}

/* ── the panel ────────────────────────────────────────────────────────────── */

function NodeForm({ node, update }: FormProps) {
  switch (node.type) {
    case "trigger": return <TriggerForm node={node} update={update} />
    case "employee": return <EmployeeForm node={node} update={update} />
    case "workflow-call": return <WorkflowCallForm node={node} update={update} />
    case "condition": return <ConditionForm node={node} update={update} />
    case "approval": return <ApprovalForm node={node} update={update} />
    case "wait": return <WaitForm node={node} update={update} />
    case "end": return <EndForm node={node} update={update} />
    case "merge":
      return (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Waits for every incoming branch to finish, then continues.
        </p>
      )
  }
}

function InspectorBody({ node }: { node: WorkflowNodeWire }) {
  const renameNode = useEditor((state) => state.renameNode)
  const replaceNode = useEditor((state) => state.replaceNode)
  const removeNode = useEditor((state) => state.removeNode)
  const selectNode = useEditor((state) => state.selectNode)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <NodeTypeIcon type={node.type} node={node} size={26} iconSize={13} />
        <span className="flex-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {NODE_TYPE_LABEL[node.type]}
        </span>
        <button
          type="button"
          aria-label="Delete node"
          onClick={() => removeNode(node.id)}
          className="grid size-8 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)]"
        >
          <Trash2 size={15} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close properties"
          onClick={() => selectNode(null)}
          className="grid size-8 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-scrollable="true">
        <Field label="Name">
          <TextInput
            value={node.name}
            onChange={(event) => renameNode(node.id, event.target.value)}
            onBlur={(event) => {
              if (!event.target.value.trim()) renameNode(node.id, NODE_TYPE_LABEL[node.type])
            }}
          />
        </Field>
        <NodeForm node={node} update={replaceNode} />
        <p className="pt-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          {node.id}
        </p>
      </div>
    </div>
  )
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)")?.matches === true,
  )
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 767px)")
    if (!query) return
    const onChange = () => setNarrow(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return narrow
}

/** The inspector chrome shared by the editor properties panel and the run
 *  inspector: a right rail on desktop, a bottom sheet on mobile. */
export function InspectorShell({ onDismiss, children }: { onDismiss: () => void; children: React.ReactNode }) {
  const narrow = useIsNarrow()
  if (!narrow) {
    return (
      <aside className="absolute bottom-3 right-3 top-3 z-40 w-[324px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]">
        {children}
      </aside>
    )
  }
  return (
    <div className="fixed inset-x-0 z-40" style={{ bottom: "calc(49px + var(--safe-bottom))" }}>
      <button
        type="button"
        aria-label="Dismiss properties"
        onClick={onDismiss}
        className="absolute inset-x-0 -top-24 h-24"
      />
      <div
        className="max-h-[62vh] overflow-hidden rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] pb-2.5 shadow-[var(--shadow-overlay)]"
      >
        <div className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-[var(--fill-secondary)]" aria-hidden />
        <div className="h-[min(56vh,480px)]">{children}</div>
      </div>
    </div>
  )
}

/** Properties live in a right rail on desktop and a bottom sheet on mobile —
 *  ONE mounted body writing straight into the store node; there is no draft copy. */
export function Inspector() {
  const selected = useEditor((state) => state.nodes.find((node) => node.selected))
  const selectNode = useEditor((state) => state.selectNode)
  if (!selected) return null
  return (
    <InspectorShell onDismiss={() => selectNode(null)}>
      <InspectorBody node={selected.data.node} />
    </InspectorShell>
  )
}
