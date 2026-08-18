import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it } from "vitest"

import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import type { WorkflowNodeWire } from "../editor/ports"
import { createEditorStore, EditorStoreContext } from "../editor/store"

const definition: WorkflowDefinitionV2Wire = {
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
  initial.ui.positions = { [node.id]: { x: 0, y: 0 } }
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

function renderApproval(config: Record<string, unknown>) {
  return renderNode({ id: "gate", type: "approval", name: "Gate", config })
}

function renderWait(config: Record<string, unknown>) {
  return renderNode({ id: "hold", type: "wait", name: "Ask operator", config })
}

function nodeConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

async function choose(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }))
  await userEvent.click(await screen.findByRole("option", { name: option }))
}

/* The gateway package is not a dependency of the web app, so these restate the
 * contracts the forms have to satisfy: `approvalNodeSchema` and
 * `waitConfigSchema` in packages/jinn/src/workflows/model.ts. A config that
 * fails one of them is a definition the gateway would refuse to save. */

function expectValidApprovalConfig(config: Record<string, unknown>) {
  expect(Object.keys(config).every((key) => ["description", "approver", "operatorOnly", "options"].includes(key))).toBe(true)
  expect(typeof config.description).toBe("string")
  if (!("options" in config)) return
  const options = config.options as unknown
  expect(Array.isArray(options)).toBe(true)
  const labels = options as unknown[]
  expect(labels.length).toBeGreaterThanOrEqual(2)
  expect(labels.length).toBeLessThanOrEqual(8)
  for (const label of labels) {
    expect(typeof label).toBe("string")
    expect((label as string).length).toBeGreaterThanOrEqual(1)
    expect((label as string).length).toBeLessThanOrEqual(80)
  }
  expect(new Set(labels).size).toBe(labels.length)
}

function expectMinutesInRange(value: unknown) {
  expect(Number.isInteger(value)).toBe(true)
  expect(value as number).toBeGreaterThanOrEqual(1)
  expect(value as number).toBeLessThanOrEqual(43_200)
}

function expectValidWaitConfig(config: Record<string, unknown>) {
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

beforeAll(() => {
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
})

describe("approval inspector operator-only gate", () => {
  it("reserves the gate and drops any approver, since the two contradict", () => {
    const store = renderApproval({ description: "Merge?", approver: { source: "fixed", value: "platform-lead" } })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(nodeConfig(store)).toEqual({ description: "Merge?", operatorOnly: true })
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
  })

  it("clears the flag entirely rather than writing operatorOnly: false", () => {
    const store = renderApproval({ description: "Merge?", operatorOnly: true })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(nodeConfig(store)).not.toHaveProperty("operatorOnly")
    expect(screen.getByLabelText("Approver (optional)")).toBeTruthy()
  })
})

describe("approval inspector fixed choices", () => {
  it("writes plain labels the gateway would accept", () => {
    const store = renderApproval({ description: "Which direction?" })

    fireEvent.click(screen.getByLabelText("Offer fixed choices"))
    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "Rewrite it" } })
    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "Patch it" } })

    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
    expectValidApprovalConfig(nodeConfig(store))
  })

  it("blocks a duplicate label inline without committing it", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 1"), { target: { value: "Patch it" } })

    expect(screen.getByText("Use a unique label.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("blocks an emptied label inline without committing it", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "" } })

    expect(screen.getByText("Give every choice a label.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("blocks a label past the length the gateway takes", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "x".repeat(81) } })

    expect(screen.getByText("Keep a choice to 80 characters or fewer.")).toBeTruthy()
    expect(nodeConfig(store).options).toEqual(["Rewrite it", "Patch it"])
  })

  it("adds a unique label and stops at eight", () => {
    const seven = ["Option 1", "Option 2", "Option 3", "Option 4", "Option 5", "Option 6", "Option 7"]
    const store = renderApproval({ description: "Which?", options: seven })
    const add = screen.getByRole("button", { name: "Add choice" }) as HTMLButtonElement

    fireEvent.click(add)

    expect(nodeConfig(store).options).toEqual([...seven, "Option 8"])
    expectValidApprovalConfig(nodeConfig(store))
    expect(add.disabled).toBe(true)
  })

  it("removes a choice but never below two", () => {
    const store = renderApproval({ description: "Which?", options: ["A", "B", "C"] })

    fireEvent.click(screen.getByRole("button", { name: "Remove choice 3" }))

    expect(nodeConfig(store).options).toEqual(["A", "B"])
    expect((screen.getByRole("button", { name: "Remove choice 1" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Remove choice 2" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps every choice control at a 34px tap target", () => {
    renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    expect(screen.getByLabelText("Choice 1").classList.contains("min-h-[34px]")).toBe(true)
    expect(screen.getByRole("button", { name: "Remove choice 1" }).classList.contains("size-[34px]")).toBe(true)
    expect(screen.getByRole("button", { name: "Add choice" }).classList.contains("h-[34px]")).toBe(true)
  })

  it("removes the options key entirely when the choices are turned off", () => {
    const store = renderApproval({ description: "Which?", options: ["Rewrite it", "Patch it"] })

    fireEvent.click(screen.getByLabelText("Offer fixed choices"))

    expect("options" in nodeConfig(store)).toBe(false)
    expect(screen.queryByLabelText("Choice 1")).toBeNull()
  })

  it("keeps authored choices while an unrelated field is edited", () => {
    const options = ["Rewrite it", "Patch it", "Leave it"]
    const store = renderApproval({ description: "Which?", options })

    fireEvent.change(screen.getByLabelText("What needs approval?"), { target: { value: "Which direction?" } })

    expect(nodeConfig(store)).toEqual({ description: "Which direction?", options })
  })
})

describe("wait inspector modes", () => {
  it("writes the gateway's default when the Todo-comment mode is picked", async () => {
    const store = renderWait({ mode: "duration", minutes: 60 })

    await choose("Wait", "Until a Todo comment")

    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("clamps an edited timeout into the range the gateway takes", () => {
    const store = renderWait({ mode: "todo-comment", timeoutMinutes: 10_080 })

    fireEvent.change(screen.getByLabelText("Timeout (minutes)"), { target: { value: "90000" } })

    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 43_200 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("stays valid switching from a Todo comment to a duration and back", async () => {
    const store = renderWait({ mode: "todo-comment", timeoutMinutes: 240 })

    await choose("Wait", "For a duration")
    expect(nodeConfig(store)).toEqual({ mode: "duration", minutes: 60 })
    expectValidWaitConfig(nodeConfig(store))

    await choose("Wait", "Until a Todo comment")
    expect(nodeConfig(store)).toEqual({ mode: "todo-comment", timeoutMinutes: 10_080 })
    expectValidWaitConfig(nodeConfig(store))
  })

  it("explains a mode it cannot render read-only instead of downgrading it", () => {
    const config = { mode: "signal", channel: "deploys" }
    const store = renderWait(config)

    expect(screen.getByText(/does not\s+know/)).toBeTruthy()
    // Every control in this form replaces the whole config, so one appearing here
    // is the data loss itself: the mode and its own keys would be gone on first touch.
    expect(screen.queryByRole("combobox", { name: "Wait" })).toBeNull()
    expect(screen.queryByLabelText("Minutes")).toBeNull()
    expect(screen.queryByLabelText("Timeout (minutes)")).toBeNull()
    expect(screen.queryByLabelText("Timestamp (ISO)")).toBeNull()
    expect(nodeConfig(store)).toEqual(config)
    expect(store.getState().serial).toBe(0)
  })

  it("keeps the timeout input at a 34px tap target", () => {
    renderWait({ mode: "todo-comment", timeoutMinutes: 10_080 })

    expect(screen.getByLabelText("Timeout (minutes)").classList.contains("min-h-[34px]")).toBe(true)
  })

  it("still edits a duration wait", () => {
    const store = renderWait({ mode: "duration", minutes: 60 })

    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "30" } })

    expect(nodeConfig(store)).toEqual({ mode: "duration", minutes: 30 })
  })
})
