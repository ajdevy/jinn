import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    getOrg: () => Promise.resolve({ departments: ["platform"], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
    listLabels: () => Promise.resolve({ labels: [] }),
  },
}))

import type { WorkflowDefinitionWire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import { createEditorStore, EditorStoreContext } from "../editor/store"

/** PLA-149: which engines cover for this node's own is authored here, and a chain
 *  someone wrote as JSON has to survive being looked at. */

const definition: WorkflowDefinitionWire = {
  schemaVersion: 1, id: "morning-digest", title: "Morning Digest", revision: 3, enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [{ id: "writer", type: "employee", name: "Writer",
    config: { employee: { source: "fixed", value: "writer" }, prompt: "" } }],
  edges: [], ui: { positions: { writer: { x: 0, y: 0 } } },
}

function renderInspector(configPatch: Record<string, unknown> = {}) {
  const initial = structuredClone(definition)
  initial.nodes[0]!.config = { ...initial.nodes[0]!.config, ...configPatch }
  const store = createEditorStore(initial)
  store.getState().selectNode("writer")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EditorStoreContext.Provider value={store}>
        <Inspector />
      </EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function fallbackOf(store: ReturnType<typeof createEditorStore>) {
  return (store.getState().nodes[0]!.data.node.config as Record<string, unknown>).fallback
}

const picker = () => screen.getByRole("combobox", { name: "Fallback" })

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
})

describe("the Employee form's Fallback select", () => {
  it("reads an absent fallback as Inherit", () => {
    renderInspector()

    expect(picker().textContent).toBe("Inherit")
  })

  it("writes the chosen value onto the node config, and reads it back", async () => {
    const store = renderInspector()

    await userEvent.click(picker())
    await userEvent.click(await screen.findByRole("option", { name: "None" }))

    expect(fallbackOf(store)).toBe("none")
    expect(picker().textContent).toBe("None")
  })

  it("shows a JSON-authored chain rather than flattening it, and will not offer it as a choice", async () => {
    renderInspector({ fallback: ["claude", "grok"] })

    expect(picker().textContent).toBe("claude → grok")
    await userEvent.click(picker())
    expect((await screen.findByRole("option", { name: "claude → grok" })).getAttribute("aria-disabled")).toBe("true")
  })
})
