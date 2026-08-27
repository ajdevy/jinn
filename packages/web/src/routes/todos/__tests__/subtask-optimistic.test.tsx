import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import { workItemNode } from "./fixtures/task-wire"
import { PENDING_SUBTASK_PREFIX, useSubTaskMutations } from "../task-page/use-subtask-mutations"

/** ICI-1437 — the add lands in the tree cache before the gateway answers, and a
 *  refusal takes it straight back out through the page's own error lane. */

const createWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, createWorkItem: (...args: unknown[]) => createWorkItem(...args) } }
})

const TREE_KEY = ["work-item-tree", "PLA-12"]

function seeded(children: WorkItemTreeNodeWire[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(TREE_KEY, {
    tree: { root: workItemNode("PLA-12", { depth: 0, parentId: null, children }), totals: {}, spendUsd: 0 },
  })
  const announced: string[] = []
  const failWith = (fallback: string) => (error: unknown) => announced.push(`${fallback} / ${String(error)}`)
  const { result } = renderHook(
    () => useSubTaskMutations({ id: "PLA-12", rootId: "PLA-12", failWith }),
    { wrapper: ({ children: tree }) => <QueryClientProvider client={client}>{tree}</QueryClientProvider> },
  )
  const rows = () => (client.getQueryData(TREE_KEY) as { tree: WorkItemTreeWire }).tree.root.children
  return { announced, result, rows }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("adding a sub-task", () => {
  it("carries the child in the tree cache before the gateway answers", async () => {
    let settle: (value: unknown) => void = () => {}
    createWorkItem.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    const { result, rows } = seeded([workItemNode("PLA-13")])

    act(() => result.current.addSubTask.mutate("E-mail receipts"))

    await waitFor(() => expect(rows().map((row) => row.title)).toEqual(["Item PLA-13", "E-mail receipts"]))
    expect(rows()[1].id).toBe(`${PENDING_SUBTASK_PREFIX}1`)
    expect(rows()[1].status).toBe("backlog")
    expect(createWorkItem).toHaveBeenCalledWith({ title: "E-mail receipts", parentId: "PLA-12" })

    await act(async () => settle({ workItem: workItemNode("PLA-23") }))
  })

  it("takes the child back out when the gateway refuses, and announces the refusal", async () => {
    createWorkItem.mockRejectedValue(new Error("parent is at the depth cap"))
    const { announced, result, rows } = seeded([workItemNode("PLA-13")])

    await act(async () => {
      await result.current.addSubTask.mutateAsync("E-mail receipts").catch(() => undefined)
    })

    expect(rows().map((row) => row.title)).toEqual(["Item PLA-13"])
    expect(announced).toEqual(["Failed to add the sub-task / Error: parent is at the depth cap"])
  })
})
