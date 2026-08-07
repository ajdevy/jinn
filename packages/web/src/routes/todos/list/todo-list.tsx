import { useEffect, useMemo, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardColumnData } from "../board/use-board"
import { groupTodoListItems } from "./group-items"
import { TodoListGroup } from "./list-group"

/** A group's paging state, gathered from the columns it spans. */
function paging(statuses: readonly WorkItemStatusWire[], columns: Record<WorkItemStatusWire, BoardColumnData>) {
  return {
    hasMore: statuses.some((status) => columns[status].hasMore),
    loadingMore: statuses.some((status) => columns[status].loadingMore),
    onLoadMore: () => {
      for (const status of statuses) {
        if (columns[status].hasMore) columns[status].loadMore()
      }
    },
  }
}

export function TodoList({
  columns,
  needsAttention,
  byName,
  trees,
  now,
  onOpen,
  onQuickAdd,
  statusInScope,
  closedInitiallyOpen = false,
}: {
  columns: Record<WorkItemStatusWire, BoardColumnData>
  needsAttention: WorkItemCompactWire[]
  byName: Map<string, Employee>
  trees: Map<string, WorkItemTreeWire> | undefined
  now: number
  onOpen: (id: string, item: WorkItemCompactWire) => void
  onQuickAdd: (askAssignee: boolean) => void
  /** Which statuses this view was asked for — see `groupTodoListItems`. */
  statusInScope?: (status: WorkItemStatusWire) => boolean
  /** A URL that named a closed status arrives with the group already open —
   *  Closed is folded because it is usually noise, and here it is the answer. */
  closedInitiallyOpen?: boolean
}) {
  const groups = useMemo(() => groupTodoListItems(columns, needsAttention, statusInScope), [columns, needsAttention, statusInScope])
  const [closedOpen, setClosedOpen] = useState(closedInitiallyOpen)
  useEffect(() => setClosedOpen(closedInitiallyOpen), [closedInitiallyOpen])

  return (
    <div className="flex flex-col gap-[18px] px-3 pb-24 pt-5 md:px-10 md:pb-10">
      {groups.map((group) => (
        <TodoListGroup
          key={group.key}
          group={group}
          byName={byName}
          trees={trees}
          now={now}
          open={group.key !== "closed" || closedOpen}
          onToggle={group.key === "closed" ? () => setClosedOpen((value) => !value) : undefined}
          onQuickAdd={() => onQuickAdd(group.key === "assigned")}
          onOpen={onOpen}
          {...paging(group.statuses, columns)}
        />
      ))}
    </div>
  )
}
