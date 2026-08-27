import { useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { WorkItemStatusWire, WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"

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

/**
 * The task page's sub-task writes. The add lands in the tree cache before the
 * gateway answers so the row is there under the field the operator is still
 * typing in, and a refusal takes it straight back out and says why.
 */
export function useSubTaskMutations({
  id,
  rootId,
  failWith,
}: {
  id: string | null
  rootId: string
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

  return { childStatus, childAssign, addSubTask: useAddSubTask({ id, rootId, failWith, invalidateTree }) }
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
  failWith,
  invalidateTree,
}: {
  id: string | null
  rootId: string
  failWith: (fallback: string) => (error: unknown) => void
  invalidateTree: () => void
}) {
  const qc = useQueryClient()
  const pendingSeq = useRef(0)
  const key = ["work-item-tree", rootId]

  return useMutation({
    mutationFn: (title: string) => api.createWorkItem({ title, parentId: id! }),
    onMutate: async (title: string) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<TreeData>(key)
      if (previous && id) {
        pendingSeq.current += 1
        const pendingId = `${PENDING_SUBTASK_PREFIX}${pendingSeq.current}`
        qc.setQueryData<TreeData>(key, {
          ...previous,
          tree: { ...previous.tree, root: withPendingChild(previous.tree.root, id, pendingId, title) },
        })
      }
      return { previous }
    },
    onError: (error, _title, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous)
      failWith("Failed to add the sub-task")(error)
    },
    onSettled: invalidateTree,
  })
}
