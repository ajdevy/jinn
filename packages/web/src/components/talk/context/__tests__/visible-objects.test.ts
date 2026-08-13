import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { queryClient } from "@/lib/query-client"
import type { WorkItemStatusWire } from "@/lib/api"
import type { TodoFilters } from "@/lib/todos"
import type { BoardId } from "@/routes/todos/board/board-route"
import { boardColumnQueryKey } from "@/routes/todos/board/use-board"
import { describeLocation } from "../page-snapshot"
import { visibleObjects } from "../visible-objects"

const PLATFORM: BoardId = { kind: "department", slug: "platform" }

/** A column exactly as the board's own infinite query leaves it in the cache. */
function seedColumn(
  status: WorkItemStatusWire,
  filters: TodoFilters,
  items: Array<{ id: string; title: string }>,
): void {
  queryClient.setQueryData(boardColumnQueryKey(PLATFORM, status, filters), {
    pages: [{ workItems: items, total: items.length, nextOffset: null }],
  })
}

beforeEach(() => queryClient.clear())
afterEach(() => queryClient.clear())

describe("the objects on the board the operator is looking at", () => {
  it("collects every column of this board, and names a Todo once", () => {
    const filters: TodoFilters = { status: "open" }
    seedColumn("executing", filters, [{ id: "ABC-1", title: "Ship the orb" }])
    seedColumn("in_review", filters, [
      { id: "ABC-1", title: "Ship the orb" },
      { id: "ABC-2", title: "Read the board" },
    ])

    expect(visibleObjects(describeLocation("/todos/b/platform", ""))).toEqual([
      { id: "ABC-1", title: "Ship the orb" },
      { id: "ABC-2", title: "Read the board" },
    ])
  })

  it("leaves a retained filter variant off the screen it is not on", () => {
    // The board keeps its previous filter's columns in the cache, so a snapshot
    // that read the board by prefix would report the Todos of a search the
    // operator has already typed past.
    seedColumn("executing", { status: "open", q: "alpha" }, [{ id: "ABC-ALPHA", title: "Alpha" }])
    seedColumn("executing", { status: "open", q: "beta" }, [{ id: "ABC-BETA", title: "Beta" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?q=beta"))).toEqual([
      { id: "ABC-BETA", title: "Beta" },
    ])
  })

  it("leaves out a column the status filter has taken off the board", () => {
    // `?status=executing` is a board of one column, and the others keep whatever
    // they loaded on the way in.
    const filters: TodoFilters = { status: "open" }
    seedColumn("executing", filters, [{ id: "ABC-1", title: "Ship the orb" }])
    seedColumn("backlog", filters, [{ id: "ABC-9", title: "Not on this board" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?status=executing"))).toEqual([
      { id: "ABC-1", title: "Ship the orb" },
    ])
  })

  it("answers with nothing when the cache is cold", () => {
    expect(visibleObjects(describeLocation("/todos/b/platform", ""))).toEqual([])
  })
})
