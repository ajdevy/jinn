import { afterEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { clearTalkNavigator, registerTalkNavigator } from "../../tools/router-handle"
import { applyTalkUiEffect } from "../ui-effects"

afterEach(() => {
  clearTalkNavigator()
  vi.restoreAllMocks()
})

describe("verified Talk UI effects", () => {
  it("invalidates the exact Todo surfaces before navigating to the visible result", async () => {
    const order: string[] = []
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (filters) => {
      order.push(`invalidate:${JSON.stringify(filters?.queryKey)}`)
    })
    registerTalkNavigator(async (path) => { order.push(`navigate:${path}`) })

    await applyTalkUiEffect({
      invalidate: ["todos", "todo:PLA-116", "todo-comments:PLA-116", "todo-sessions:PLA-116"],
      navigate: "/todos/PLA-116",
    })

    expect(invalidate).toHaveBeenCalledTimes(4)
    expect(order.at(-1)).toBe("navigate:/todos/PLA-116")
    expect(order).toContain('invalidate:["work-item","PLA-116"]')
    expect(order).toContain('invalidate:["work-item-comments","PLA-116"]')
    expect(order).toContain('invalidate:["work-item-sessions","PLA-116"]')
  })

  it("maps exact Workflow and chat receipts to their live caches", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)
    await applyTalkUiEffect({ invalidate: ["sessions", "session:s-1", "workflow-runs:build", "workflow-run:build:run-1"] })
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(["sessions"])
    expect(keys).toContainEqual(["sessions", "s-1"])
    expect(keys).toContainEqual(["workflows", "runs", "build"])
    expect(keys).toContainEqual(["workflows", "runs", "build", "run-1"])
  })
})
