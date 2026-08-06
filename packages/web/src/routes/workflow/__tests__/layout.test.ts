import { describe, expect, it } from "vitest"
import { toFlowEdges, toFlowNodes, usesManualLayout, type EditorEdge, type EditorNode } from "../editor/graph"
import { tidyLayout } from "../editor/layout"
import { nodeBox } from "../editor/ports"
import { AGENT_WRITTEN, HUMAN_ARRANGED, SNAKE, specimen } from "./fixtures/specimen"

/** The gap tidyLayout must leave around every card. Pinned here rather than
 *  imported so loosening the layout constant cannot quietly loosen the test. */
const CLEARANCE = 24

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
