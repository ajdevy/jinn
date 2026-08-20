import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect } from "vitest"

import type { WorkflowDefinitionWire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import type { WorkflowNodeOfType, WorkflowNodeWire } from "../editor/ports"
import { createEditorStore, EditorStoreContext } from "../editor/store"

/* Shared rig for the approval and wait inspector specs: one node in a store,
   the Inspector rendered over it, and the gateway contracts each form's saved
   config has to satisfy. */

const definition: WorkflowDefinitionWire = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [],
  edges: [],
  ui: { positions: {} },
}

function renderNode(node: WorkflowNodeWire) {
  const initial = structuredClone(definition)
  initial.nodes = [node]
  initial.ui = { positions: { [node.id]: { x: 0, y: 0 } } }
  const store = createEditorStore(initial)
  store.getState().selectNode(node.id)
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

export function renderApproval(config: WorkflowNodeOfType<"approval">["config"]) {
  return renderNode({ id: "gate", type: "approval", name: "Gate", config })
}

export function renderWait(config: WorkflowNodeOfType<"wait">["config"]) {
  return renderNode({ id: "hold", type: "wait", name: "Ask operator", config })
}

/** A wait mode this build's schema does not model. A gateway ahead of the web
 *  bundle can serve one, and the form's contract is to leave it untouched — so
 *  the spec has to construct what the config union deliberately cannot express. */
export function renderUnhandledWait(config: Record<string, unknown>) {
  return renderNode({ id: "hold", type: "wait", name: "Ask operator", config } as unknown as WorkflowNodeWire)
}

export function nodeConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

export async function choose(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }))
  await userEvent.click(await screen.findByRole("option", { name: option }))
}

/* The gateway package is not a dependency of the web app, so these restate the
 * contracts the forms have to satisfy: `approvalNodeSchema` and
 * `waitConfigSchema` in packages/jinn/src/workflows/model.ts. A config that
 * fails one of them is a definition the gateway would refuse to save. */

export function expectValidApprovalConfig(config: Record<string, unknown>) {
  expect(Object.keys(config).every((key) => ["description", "approver", "operatorOnly", "options"].includes(key))).toBe(true)
  expect(typeof config.description).toBe("string")
  if (!("options" in config)) return
  const options = config.options as unknown
  expect(Array.isArray(options)).toBe(true)
  const labels = options as unknown[]
  expect(labels.length).toBeGreaterThanOrEqual(2)
  expect(labels.length).toBeLessThanOrEqual(8)
  // The schema trims each label before it measures and de-duplicates them, so
  // a stored label must already be trimmed and unique once trimmed.
  for (const label of labels) {
    expect(typeof label).toBe("string")
    expect(label).toBe((label as string).trim())
    expect((label as string).length).toBeGreaterThanOrEqual(1)
    expect((label as string).length).toBeLessThanOrEqual(80)
  }
  expect(new Set(labels.map((label) => (label as string).trim())).size).toBe(labels.length)
}

function expectMinutesInRange(value: unknown) {
  expect(Number.isInteger(value)).toBe(true)
  expect(value as number).toBeGreaterThanOrEqual(1)
  expect(value as number).toBeLessThanOrEqual(43_200)
}

export function expectValidWaitConfig(config: Record<string, unknown>) {
  const keys = Object.keys(config).sort()
  if (config.mode === "duration") {
    expect(keys).toEqual(["minutes", "mode"])
    expectMinutesInRange(config.minutes)
  } else if (config.mode === "todo-comment") {
    expect(keys).toEqual(["mode", "timeoutMinutes"])
    expectMinutesInRange(config.timeoutMinutes)
  } else {
    expect(config.mode).toBe("until")
    expect(keys).toEqual(["mode", "timestamp"])
    expect(config.timestamp).toMatchObject({ source: "fixed" })
  }
}

/** jsdom ships none of these, and Radix's Select needs all of them. */
export function installInspectorDomPolyfills() {
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
}
