import { describe, expect, it } from "vitest"
import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { toFlowEdges, toFlowNodes, usesManualLayout, type EditorEdge, type EditorNode } from "../editor/graph"
import { tidyLayout } from "../editor/layout"
import { nodeBox } from "../editor/ports"

/** The gap tidyLayout must leave around every card. Pinned here rather than
 *  imported so loosening the layout constant cannot quietly loosen the test. */
const CLEARANCE = 24

const BRANCHES = ["intake", "triage", "review", "escalate", "archive"] as const
/** The first three branches carry a follow-up wait; the last two go straight to the join. */
const LONG_BRANCHES = BRANCHES.slice(0, 3)

const HEAD = ["normalize", "dedupe", "enrich", "score", "classify"] as const

/** A 23-node graph shaped like the ones agents author through the API: a long
 *  intake chain, a five-way condition fan-out with a default lane, branches of
 *  uneven length, and one retry edge that closes a cycle. */
function specimen(ui: WorkflowDefinitionV2Wire["ui"]): WorkflowDefinitionV2Wire {
  const nodes: WorkflowDefinitionV2Wire["nodes"] = [
    { id: "trigger", type: "trigger", name: "Item arrives", config: { kind: "manual" } },
    ...HEAD.map((id) => ({
      id,
      type: "employee" as const,
      name: id,
      config: { employee: { source: "fixed", value: "a-lead" }, prompt: "Do the step." },
    })),
    {
      id: "router",
      type: "condition",
      name: "Route",
      config: {
        cases: BRANCHES.map((branch, index) => ({ port: `case-${index + 1}`, label: branch, all: [] })),
        defaultPort: "else",
      },
    },
    ...BRANCHES.flatMap((branch) => [
      {
        id: `${branch}-work`,
        type: "employee" as const,
        name: `${branch} work`,
        config: { employee: { source: "fixed", value: "a-lead" }, prompt: "Handle it." },
      },
      { id: `${branch}-check`, type: "approval" as const, name: `${branch} check`, config: { description: "" } },
    ]),
    ...LONG_BRANCHES.map((branch) => ({
      id: `${branch}-followup`,
      type: "wait" as const,
      name: `${branch} follow-up`,
      config: { mode: "duration", minutes: 60 },
    })),
    { id: "join", type: "merge", name: "Join", config: { mode: "wait-all" } },
    { id: "finalize", type: "employee", name: "Finalize", config: { employee: { source: "fixed", value: "a-lead" }, prompt: "Wrap up." } },
    { id: "done", type: "end", name: "Done", config: { result: "success" } },
  ]

  const chain = ["trigger", ...HEAD, "router"]
  const edges: WorkflowDefinitionV2Wire["edges"] = [
    ...chain.slice(0, -1).map((from, index) => ({
      id: `chain-${index + 1}`,
      from: { nodeId: from, port: "success" },
      to: { nodeId: chain[index + 1]!, port: "input" as const },
    })),
    ...BRANCHES.flatMap((branch, index) => [
      { id: `fan-${index + 1}`, from: { nodeId: "router", port: `case-${index + 1}` }, to: { nodeId: `${branch}-work`, port: "input" as const } },
      { id: `work-${index + 1}`, from: { nodeId: `${branch}-work`, port: "success" }, to: { nodeId: `${branch}-check`, port: "input" as const } },
    ]),
    ...BRANCHES.map((branch, index) => ({
      id: `settle-${index + 1}`,
      from: { nodeId: `${branch}-check`, port: "approved" },
      to: {
        nodeId: LONG_BRANCHES.includes(branch as (typeof LONG_BRANCHES)[number]) ? `${branch}-followup` : "join",
        port: "input" as const,
      },
    })),
    ...LONG_BRANCHES.map((branch, index) => ({
      id: `followup-${index + 1}`,
      from: { nodeId: `${branch}-followup`, port: "success" },
      to: { nodeId: "join", port: "input" as const },
    })),
    { id: "default", from: { nodeId: "router", port: "else" }, to: { nodeId: "join", port: "input" as const } },
    { id: "retry", from: { nodeId: "archive-check", port: "rejected" }, to: { nodeId: "classify", port: "input" as const } },
    { id: "wrap", from: { nodeId: "join", port: "success" }, to: { nodeId: "finalize", port: "input" as const } },
    { id: "finish", from: { nodeId: "finalize", port: "success" }, to: { nodeId: "done", port: "input" as const } },
  ]

  return {
    schemaVersion: 1,
    id: "item-pipeline",
    title: "Item pipeline",
    revision: 4,
    enabled: false,
    createdAt: "2026-08-06T08:00:00.000Z",
    updatedAt: "2026-08-06T08:00:00.000Z",
    nodes,
    edges,
    ui,
  }
}

/** What an agent writes: a fixed 200px pitch snaked across rows, blind to the
 *  edges — and narrower than the 224px card, so the cards collide. */
function snakePositions(definition: WorkflowDefinitionV2Wire): Record<string, { x: number; y: number }> {
  const perRow = 12
  return Object.fromEntries(
    definition.nodes.map((node, index) => [
      node.id,
      { x: 40 + (index % perRow) * 200, y: 300 + Math.floor(index / perRow) * 120 },
    ]),
  )
}

function overlap(a: EditorNode, b: EditorNode): boolean {
  const boxA = nodeBox(a.data.node)
  const boxB = nodeBox(b.data.node)
  return (
    a.position.x < b.position.x + boxB.width + CLEARANCE &&
    a.position.x + boxA.width + CLEARANCE > b.position.x &&
    a.position.y < b.position.y + boxB.height + CLEARANCE &&
    a.position.y + boxA.height + CLEARANCE > b.position.y
  )
}

function overlappingPairs(nodes: EditorNode[]): string[] {
  const pairs: string[] = []
  for (const [index, node] of nodes.entries()) {
    for (const other of nodes.slice(index + 1)) {
      if (overlap(node, other)) pairs.push(`${node.id} / ${other.id}`)
    }
  }
  return pairs
}

/** Depth-first back edges — the ones a left-to-right layout cannot honour
 *  because they point at an ancestor. Everything else must read forwards. */
function cycleClosingEdges(nodes: EditorNode[], edges: EditorEdge[]): Set<string> {
  const outgoing = new Map<string, EditorEdge[]>()
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  const back = new Set<string>()
  const done = new Set<string>()
  const onStack = new Set<string>()

  const walk = (id: string) => {
    onStack.add(id)
    for (const edge of outgoing.get(id) ?? []) {
      if (onStack.has(edge.target)) back.add(edge.id)
      else if (!done.has(edge.target)) walk(edge.target)
    }
    onStack.delete(id)
    done.add(id)
  }
  for (const node of nodes) if (!done.has(node.id)) walk(node.id)
  return back
}

const SNAKE = snakePositions(specimen({ positions: {} }))
const AGENT_WRITTEN = specimen({ positions: SNAKE })
const HUMAN_ARRANGED = specimen({ positions: SNAKE, layout: "manual" })

describe("workflow canvas layout", () => {
  it("treats agent-written positions as auto layout and a marked arrangement as manual", () => {
    expect(usesManualLayout(AGENT_WRITTEN)).toBe(false)
    expect(usesManualLayout(HUMAN_ARRANGED)).toBe(true)
  })

  it("re-tidies a marked arrangement that is missing a position for any node", () => {
    const incomplete = specimen({ positions: { ...SNAKE }, layout: "manual" })
    delete incomplete.ui.positions["finalize"]
    expect(usesManualLayout(incomplete)).toBe(false)
  })

  it("reproduces the defect: the stored positions overlap", () => {
    expect(overlappingPairs(toFlowNodes(AGENT_WRITTEN)).length).toBeGreaterThan(0)
  })

  it("lays the specimen out with no overlapping node boxes", () => {
    const placed = tidyLayout(toFlowNodes(AGENT_WRITTEN), toFlowEdges(AGENT_WRITTEN))
    expect(placed).toHaveLength(23)
    expect(overlappingPairs(placed)).toEqual([])
  })

  it("lays the specimen out so every non-cycle edge reads left to right", () => {
    const edges = toFlowEdges(AGENT_WRITTEN)
    const placed = tidyLayout(toFlowNodes(AGENT_WRITTEN), edges)
    const back = cycleClosingEdges(placed, edges)
    expect(back.size).toBe(1)

    const byId = new Map(placed.map((node) => [node.id, node]))
    const backwards = edges
      .filter((edge) => !back.has(edge.id))
      .filter((edge) => {
        const source = byId.get(edge.source)!
        const target = byId.get(edge.target)!
        return source.position.x + nodeBox(source.data.node).width > target.position.x
      })
      .map((edge) => `${edge.source} → ${edge.target}`)
    expect(backwards).toEqual([])
  })
})
