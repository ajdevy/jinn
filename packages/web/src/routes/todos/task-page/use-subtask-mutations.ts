import { useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { WorkItemFullWire, WorkItemStatusWire, WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"

/** The id an optimistic child wears until the gateway mints the real one. The
 *  colon keeps it clear of the id space the gateway hands out. */
export const PENDING_SUBTASK_PREFIX = "pending:"

type TreeData = { tree: WorkItemTreeWire }

/**
 * The parent's own row supplies every field the optimistic child does not set:
 * the node has to satisfy the wire type and survive one round trip, and the
 * refetch that follows replaces the whole tree with the gateway's answer.
 */
function withPendingChild(
  node: WorkItemTreeNodeWire,
  parentId: string,
  id: string,
  title: string,
): WorkItemTreeNodeWire {
  const children = node.children ?? []
  if (node.id !== parentId) {
    return { ...node, children: children.map((child) => withPendingChild(child, parentId, id, title)) }
  }
  const pending: WorkItemTreeNodeWire = {
    ...node,
    id,
    title,
    body: null,
    status: "backlog",
    assignee: null,
    parentId: node.id,
    depth: (node.depth ?? 0) + 1,
    children: [],
  }
  return { ...node, children: [...children, pending] }
}

/** Drops one optimistic child and leaves every other row where it is — a
 *  sibling create still in flight has its own row in this same tree. */
function withoutChild(node: WorkItemTreeNodeWire, id: string): WorkItemTreeNodeWire {
  const children = node.children ?? []
  return { ...node, children: children.filter((child) => child.id !== id).map((child) => withoutChild(child, id)) }
}

/** The tree to write the optimistic child into. The operator reaches the field
 *  before the tree fetch does, so when the cache is still empty the Todo's own
 *  row stands in as the root until the refetch replaces it. */
function treeToPatch(current: TreeData | undefined, item: WorkItemFullWire | undefined): WorkItemTreeWire | undefined {
  if (current) return current.tree
  return item ? { root: { ...item, children: [] }, totals: {}, spendUsd: 0 } : undefined
}

/**
 * The task page's sub-task writes. The add lands in the tree cache before the
 * gateway answers so the row is there under the field the operator is still
 * typing in, and a refusal takes it straight back out and says why.
 */
export function useSubTaskMutations({
  id,
  rootId,
  item,
  failWith,
}: {
  id: string | null
  rootId: string
  item: WorkItemFullWire | undefined
  failWith: (fallback: string) => (error: unknown) => void
}) {
  const invalidateTree = useInvalidateTree(id)

  const childStatus = useMutation({
    mutationFn: ({ childId, status, cascade }: { childId: string; status: WorkItemStatusWire; cascade?: boolean }) =>
      cascade ? api.setWorkItemStatus(childId, status, undefined, undefined, { cascade }) : api.setWorkItemStatus(childId, status),
    onError: failWith("The gateway refused the move"),
    onSettled: invalidateTree,
  })

  const childAssign = useMutation({
    mutationFn: ({ childId, assignee }: { childId: string; assignee: string }) => api.assignWorkItem(childId, assignee),
    onError: failWith("Couldn't assign the sub-task"),
    onSettled: invalidateTree,
  })

  return { childStatus, childAssign, addSubTask: useAddSubTask({ id, rootId, item, failWith, invalidateTree }) }
}

/** Every surface that reads this Todo or its tree, refreshed together. */
function useInvalidateTree(id: string | null) {
  const qc = useQueryClient()
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["work-item-tree"] })
    void qc.invalidateQueries({ queryKey: ["work-items"] })
    if (id) void qc.invalidateQueries({ queryKey: ["work-item", id] })
  }, [qc, id])
}

function useAddSubTask({
  id,
  rootId,
  item,
  failWith,
  invalidateTree,
}: {
  id: string | null
  rootId: string
  item: WorkItemFullWire | undefined
  failWith: (fallback: string) => (error: unknown) => void
  invalidateTree: () => void
}) {
  const qc = useQueryClient()
  const pendingSeq = useRef(0)
  const inFlight = useRef(0)
  const key = ["work-item-tree", rootId]

  return useMutation({
    mutationFn: (title: string) => api.createWorkItem({ title, parentId: id! }),
    onMutate: async (title: string) => {
      pendingSeq.current += 1
      inFlight.current += 1
      const pendingId = `${PENDING_SUBTASK_PREFIX}${pendingSeq.current}`
      // A tree fetch already in flight would land without this child in it.
      await qc.cancelQueries({ queryKey: key })
      qc.setQueryData<TreeData>(key, (current) => {
        const tree = treeToPatch(current, item)
        return tree && id ? { tree: { ...tree, root: withPendingChild(tree.root, id, pendingId, title) } } : current
      })
      return { pendingId }
    },
    onError: (error, _title, context) => {
      if (context) {
        qc.setQueryData<TreeData>(key, (current) =>
          current ? { tree: { ...current.tree, root: withoutChild(current.tree.root, context.pendingId) } } : current,
        )
      }
      failWith("Failed to add the sub-task")(error)
    },
    onSettled: () => {
      // The refetch answers for every add at once, so only the last one still in
      // flight asks for it: an earlier refresh would drop its siblings' rows.
      inFlight.current -= 1
      if (inFlight.current === 0) invalidateTree()
    },
  })
}
