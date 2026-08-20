import type { WorkflowDefinitionWire } from "@/lib/api"

export type WorkflowNodeWire = WorkflowDefinitionWire["nodes"][number]
export type WorkflowNodeType = WorkflowNodeWire["type"]
/** One arm of the node union, picked by its `type`. */
export type WorkflowNodeOfType<T extends WorkflowNodeType> = Extract<WorkflowNodeWire, { type: T }>

/** A binding whose fixed value is a plain string — what the Employee and
 *  Workflow-call pickers write. */
export type StringBinding = WorkflowNodeOfType<"employee">["config"]["employee"]

/** The literal someone typed into a picker, or null when the binding points at
 *  run data instead — a caption can only show the former. Tolerates an absent
 *  binding: the schema requires one, but a caption blanking the whole canvas is
 *  the wrong way to report a definition that somehow arrived without it. */
export function fixedBinding(binding: StringBinding | undefined): string | null {
  return binding?.source === "fixed" && binding.value ? binding.value : null
}

/** Rendering metadata for one output port. Placement is a visual concern only —
 *  connection/graph validation verdicts always come from the server. */
export interface OutputPortSpec {
  id: string
  label: string
  /** "side" = right wall (primary flow), "bottom" = bottom-right corner
   *  (failure lanes — spatially separated so hit areas never stack). */
  wall: "side" | "bottom"
  /** Center of the port dot within the declared node box. */
  x: number
  y: number
}

export const NODE_WIDTH = 224
export const CARD_HEIGHT = 64
export const DISC_SIZE = 56
export const COND_HEADER = 54
export const COND_ROW = 30
export const COND_PAD = 6

/** A case still being authored can hold an empty port, which draws no dot. */
export function conditionCases(node: WorkflowNodeWire): Array<{ port: string; label: string }> {
  if (node.type !== "condition") return []
  return node.config.cases
    .filter((item) => item.port.length > 0)
    .map((item) => ({ port: item.port, label: item.label.trim() || item.port }))
}

export function conditionDefaultPort(node: WorkflowNodeWire): string {
  const port = node.type === "condition" ? node.config.defaultPort : ""
  return port.length > 0 ? port : "else"
}

/** Declared node box — MUST equal the rendered card (fixed heights, no estimates). */
export function nodeBox(node: WorkflowNodeWire): { width: number; height: number } {
  switch (node.type) {
    case "merge":
      return { width: DISC_SIZE, height: DISC_SIZE }
    case "condition": {
      const rows = conditionCases(node).length + 1
      return { width: NODE_WIDTH, height: COND_HEADER + rows * COND_ROW + COND_PAD }
    }
    default:
      return { width: NODE_WIDTH, height: CARD_HEIGHT }
  }
}

/** Output ports with their exact dot centers on the box perimeter. */
export function outputPorts(node: WorkflowNodeWire): OutputPortSpec[] {
  const box = nodeBox(node)
  switch (node.type) {
    case "trigger":
    case "workflow-call":
    case "wait":
    case "merge":
      return [{ id: "success", label: "", wall: "side", x: box.width, y: box.height / 2 }]
    case "employee":
      return [
        { id: "success", label: "", wall: "side", x: box.width, y: box.height / 2 },
        { id: "error", label: "error", wall: "bottom", x: box.width - 28, y: box.height },
      ]
    case "approval":
      return [
        { id: "approved", label: "", wall: "side", x: box.width, y: box.height / 2 },
        { id: "rejected", label: "rejected", wall: "bottom", x: box.width - 28, y: box.height },
      ]
    case "condition": {
      const rows = [...conditionCases(node), { port: conditionDefaultPort(node), label: "else" }]
      return rows.map((row, index) => ({
        id: row.port,
        label: row.label,
        wall: "side" as const,
        x: NODE_WIDTH,
        y: COND_HEADER + index * COND_ROW + COND_ROW / 2,
      }))
    }
    case "end":
      return []
  }
}

export function acceptsInput(type: WorkflowNodeType): boolean {
  return type !== "trigger"
}

/** Max incoming connections rendered by the input handle (merge is unbounded).
 *  A limit here is a drawing affordance, not the rule engine. */
export function inputConnectionLimit(type: WorkflowNodeType): number | undefined {
  return type === "merge" ? undefined : 1
}

export const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  trigger: "Trigger",
  employee: "Employee",
  "workflow-call": "Workflow call",
  condition: "Condition",
  merge: "Merge",
  approval: "Approval",
  wait: "Wait",
  end: "End",
}
