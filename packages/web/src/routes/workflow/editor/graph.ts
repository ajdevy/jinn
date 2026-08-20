import type { Edge, Node } from "@xyflow/react"
import type { WorkflowDefinitionWire } from "@/lib/api"
import { NODE_TYPE_LABEL, type WorkflowNodeType, type WorkflowNodeWire, nodeBox } from "./ports"

/** Live run state painted onto a card when the canvas renders a run. Its
 *  presence flips the card into read-only mode: no add affordances, handles
 *  not connectable, status badge + tinted ring instead. */
export interface NodeRunView {
  status: string
  dimmed: boolean
  /** `rounds` is set when the call iterates: a round is a whole child run, so
   *  the card counts rounds rather than folding them into one child tally. */
  workflowCall?: { succeeded: number; total: number; rounds?: { round: number; maxRounds: number } }
  waitComment?: { todoId: string; timeoutMinutes: number }
}

/** Run state for one wire: `taken` marks the traversed path. Its presence
 *  hides the edge's insert affordance. */
export interface EdgeRunView {
  taken: boolean
}

/** What a Workflow Call card counts: rounds when it loops, children when it
 *  fans out. */
export function workflowCallProgress(call: NonNullable<NodeRunView["workflowCall"]>): string {
  return call.rounds ? `Round ${call.rounds.round}/${call.rounds.maxRounds}` : `${call.succeeded}/${call.total}`
}

export type EditorNodeData = { node: WorkflowNodeWire; run?: NodeRunView }
export type EditorNode = Node<EditorNodeData>
export type EditorEdgeData = { run?: EdgeRunView }
export type EditorEdge = Edge<EditorEdgeData>

/** The subset of a definition the canvas can draw — run detail carries this
 *  snapshot shape; the editor passes the full definition. */
export type GraphSnapshot = Pick<WorkflowDefinitionWire, "nodes" | "edges"> & {
  ui?: WorkflowDefinitionWire["ui"]
}

/** Everything about the definition that is not the graph itself, echoed back on save. */
export interface EditorMeta {
  id: string
  title: string
  description?: string
  revision: number
  enabled: boolean
  retiredAt: string | null
  inputs?: WorkflowDefinitionWire["inputs"]
  createdAt: string
  updatedAt: string
}

export function toEditorMeta(definition: WorkflowDefinitionWire): EditorMeta {
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    revision: definition.revision,
    enabled: definition.enabled,
    retiredAt: definition.retiredAt ?? null,
    ...(definition.inputs === undefined ? {} : { inputs: definition.inputs }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

export function toFlowNodes(definition: GraphSnapshot): EditorNode[] {
  const positions = definition.ui?.positions ?? {}
  return definition.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: positions[node.id] ?? { x: 0, y: 0 },
    data: { node },
    ...nodeBox(node),
  }))
}

export function toFlowEdges(definition: GraphSnapshot): EditorEdge[] {
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.from.nodeId,
    sourceHandle: edge.from.port,
    target: edge.to.nodeId,
    targetHandle: "input",
    type: "workflow",
  }))
}

/** Whether the canvas should honour the stored coordinates. Agents author
 *  definitions through the API and write positions too, so the marker the
 *  editor stamps — not the presence of coordinates — is the evidence a person
 *  arranged this. Completeness still matters: a node added to an arranged graph
 *  has no position of its own, and dropping it at the origin reads worse than
 *  re-tidying the whole thing. */
export function usesManualLayout(definition: GraphSnapshot): boolean {
  if (definition.ui?.layout !== "manual") return false
  const positions = definition.ui.positions
  return definition.nodes.length > 0 && definition.nodes.every((node) => positions[node.id] !== undefined)
}

/** Map the store back to the full wire definition for PUT. The server owns
 *  revision/enabled/timestamps; we echo the last acknowledged values. */
export function serializeDefinition(
  meta: EditorMeta,
  nodes: EditorNode[],
  edges: EditorEdge[],
): WorkflowDefinitionWire {
  return {
    schemaVersion: 1,
    id: meta.id,
    title: meta.title,
    ...(meta.description === undefined || meta.description === "" ? {} : { description: meta.description }),
    revision: meta.revision,
    enabled: meta.enabled,
    ...(meta.inputs === undefined ? {} : { inputs: meta.inputs }),
    // Spread rather than rebuild: listing the fields back out would decouple
    // `type` from `config` and lose which arm of the union this node is.
    nodes: nodes.map(({ data: { node } }) => ({ ...node, name: node.name.trim() || NODE_TYPE_LABEL[node.type] })),
    edges: edges.map((edge) => ({
      id: edge.id,
      from: { nodeId: edge.source, port: edge.sourceHandle ?? "success" },
      to: { nodeId: edge.target, port: "input" as const },
    })),
    // The editor is the only surface where a person arranges the canvas, so
    // saving from it is what makes these coordinates authoritative.
    ui: {
      positions: Object.fromEntries(
        nodes.map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]),
      ),
      layout: "manual",
    },
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

export function allocateNodeId(type: WorkflowNodeType, taken: ReadonlySet<string>): string {
  if (!taken.has(type)) return type
  for (let index = 2; ; index += 1) {
    const candidate = `${type}-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

export function allocateEdgeId(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `e${index}`
    if (!taken.has(candidate)) return candidate
  }
}

export function allocateConditionPort(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `case-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Each arm returns the whole node, not just its config: `type` and `config`
 *  are one choice, and splitting them is what lets a wrong pair compile. */
export function createWorkflowNode(type: WorkflowNodeType, id: string): WorkflowNodeWire {
  const name = NODE_TYPE_LABEL[type]
  switch (type) {
    case "trigger":
      return { id, type, name, config: { kind: "manual" } }
    case "employee":
      return { id, type, name, config: { employee: { source: "fixed", value: "" }, prompt: "" } }
    case "workflow-call":
      return { id, type, name, config: { workflowId: { source: "fixed", value: "" }, concurrency: 2 } }
    case "condition":
      return { id, type, name, config: { cases: [{ port: "case-1", label: "Case 1", all: [] }], defaultPort: "else" } }
    case "merge":
      return { id, type, name, config: { mode: "wait-all" } }
    case "approval":
      return { id, type, name, config: { description: "" } }
    case "wait":
      return { id, type, name, config: { mode: "duration", minutes: 60 } }
    case "end":
      return { id, type, name, config: { result: "success" } }
  }
}
