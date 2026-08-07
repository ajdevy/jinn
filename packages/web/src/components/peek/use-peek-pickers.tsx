import { useCallback, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  ApiError,
  isPositiveTodoVersion,
  type Employee,
  type WorkItemDetailWire,
  type WorkItemStatusWire,
} from '@/lib/api'
import { TODO_WRITE_KEY } from '@/lib/query-keys'
import { operatorSafeTodoError } from '@/lib/todos'
import { PickerNote, PickerPopover, PickerSheet } from '@/routes/todos/pickers/picker-shell'
import { AssigneePickerContent, StatusPickerContent } from '@/routes/todos/pickers/picker-contents'
import {
  invalidateTodoCaches,
  mergeTodoIntoCaches,
  newTodoEditRequest,
  saveTodoDetailRemote,
} from '@/routes/todos/todo-edit-request'
import { useSetWorkItemStatus } from '@/routes/todos/use-todos'

/* The peek rail's two quick actions. The shells and the picker contents are the
 * task page's, unchanged — one picker grammar for the whole app. What lives here
 * is only what the peek does differently: one picker at a time out of two rather
 * than seven, no live region to announce into (the panel shows the refusal
 * inline), and the child count the close gate needs fetched on demand, because
 * the peek's detail payload does not carry one. */

export type PeekPickerKey = 'status' | 'assignee'

const PICKER_TITLE: Record<PeekPickerKey, string> = { status: 'Status', assignee: 'Assignee' }

export interface PeekPickerRow {
  onOpen: () => void
  open: boolean
  /** The desktop popover, anchored on the row. Null on the phone, where the one
   *  sheet is portalled at panel level instead. */
  picker: ReactNode
}

/** The panel's one refusal line. `fromGateway` keeps the board/task idiom: a
 *  mapped safe copy where the error carries a known code, the gateway's own
 *  sentence otherwise. */
function useRefusal() {
  const [message, setMessage] = useState<string | null>(null)
  const show = useCallback((text: string) => setMessage(text), [])
  const clear = useCallback(() => setMessage(null), [])
  const fromGateway = useCallback((cause: unknown, fallback: string) => {
    setMessage(operatorSafeTodoError(cause, cause instanceof ApiError ? cause.message : fallback))
  }, [])
  return { message, show, clear, fromGateway }
}

type Refusal = ReturnType<typeof useRefusal>

/** The close gate's pre-check: legalTargets() needs the open-child count or it
 *  offers a Done the gateway will refuse. Asked for only while it is needed. */
function useOpenChildren(id: string | undefined, active: boolean) {
  const tree = useQuery({
    queryKey: ['work-item-tree', id ?? ''],
    queryFn: () => api.getWorkItemTree(id!),
    enabled: !!id && active,
    staleTime: 10_000,
  })
  const count = (tree.data?.tree.root.children ?? [])
    .filter((child) => child.status !== 'done' && child.status !== 'cancelled').length
  return { count, pending: tree.isPending }
}

function useStatusLane(id: string | undefined, refusal: Refusal) {
  const setStatus = useSetWorkItemStatus()
  return useCallback((status: WorkItemStatusWire) => {
    if (!id) return
    refusal.clear()
    // The shared lane patches every cache that holds this Todo — the preview one
    // this panel reads included — so the row moves before the request resolves.
    setStatus.mutate({ id, status }, {
      onError: (cause) => refusal.fromGateway(cause, 'The gateway refused the move'),
    })
  }, [id, setStatus, refusal])
}

/** `/assign` takes a name and cannot express "nobody", so Unassign goes through
 *  the conditional edit lane the task page's own Unassign row uses. Both wear
 *  TODO_WRITE_KEY, which is what defers a live invalidation mid-write. */
type AssignVariables = { assignee: string } | { assignee: null; expectedVersion: number }

function useAssignLane(detail: WorkItemDetailWire | undefined, refusal: Refusal) {
  const qc = useQueryClient()
  const id = detail?.workItem.id

  const showAssignee = useCallback((assignee: string | null) => {
    if (!id) return
    qc.setQueryData<WorkItemDetailWire>(['work-item-preview', id], (current) =>
      current ? { ...current, workItem: { ...current.workItem, assignee } } : current)
  }, [qc, id])

  const assign = useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: async (variables: AssignVariables) => {
      if (variables.assignee === null) {
        await saveTodoDetailRemote(qc, id!, newTodoEditRequest({ assignee: null }, variables.expectedVersion))
        return
      }
      mergeTodoIntoCaches(qc, (await api.assignWorkItem(id!, variables.assignee)).workItem)
    },
    onMutate: (variables: AssignVariables) => {
      const previous = detail?.workItem.assignee ?? null
      showAssignee(variables.assignee)
      return { previous }
    },
    onError: (cause, _variables, context) => {
      showAssignee(context?.previous ?? null)
      refusal.fromGateway(cause, 'The gateway refused the assignment')
    },
    onSettled: () => {
      if (id) void invalidateTodoCaches(qc, id)
    },
  })

  return useCallback((assignee: string | null) => {
    if (!detail) return
    refusal.clear()
    if (assignee !== null) return assign.mutate({ assignee })
    const expectedVersion = detail.workItem.version
    if (!isPositiveTodoVersion(expectedVersion)) {
      refusal.show('This Todo is missing an authoritative version — open it full to unassign.')
      return
    }
    assign.mutate({ assignee: null, expectedVersion })
  }, [detail, assign, refusal])
}

/** Closing hands focus back to the row that opened the picker (§7.3 keyboard
 *  contract), once the picker has left the tree. */
function useCloseToAnchor(setOpen: Dispatch<SetStateAction<PeekPickerKey | null>>) {
  return useCallback(() => {
    setOpen((current) => {
      if (current) {
        queueMicrotask(() => document.querySelector<HTMLElement>(`[data-testid="peek-row-${current}"]`)?.focus())
      }
      return null
    })
  }, [setOpen])
}

function usePickerContent({ detail, employees, close, children, transitionTo, commitAssignee }: {
  detail: WorkItemDetailWire | undefined
  employees: Employee[]
  close: () => void
  children: { count: number; pending: boolean }
  transitionTo: (status: WorkItemStatusWire) => void
  commitAssignee: (assignee: string | null) => void
}) {
  return useCallback((key: PeekPickerKey, inSheet: boolean): ReactNode => {
    if (!detail) return null
    const shared = { detail, sheet: inSheet, onDone: close }
    if (key === 'assignee') {
      return <AssigneePickerContent {...shared} employees={employees} commit={commitAssignee} />
    }
    // Rows wait for the count rather than offering a Done that may not be legal.
    if (children.pending) return <PickerNote>Checking sub-tasks…</PickerNote>
    return <StatusPickerContent {...shared} openChildren={children.count} commit={transitionTo} />
  }, [detail, close, employees, commitAssignee, children.pending, children.count, transitionTo])
}

export function usePeekPickers({ detail, employees, sheet, onOpenChange }: {
  detail: WorkItemDetailWire | undefined
  employees: Employee[]
  sheet: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState<PeekPickerKey | null>(null)
  const refusal = useRefusal()
  const children = useOpenChildren(detail?.workItem.id, open === 'status')
  const transitionTo = useStatusLane(detail?.workItem.id, refusal)
  const commitAssignee = useAssignLane(detail, refusal)
  const close = useCloseToAnchor(setOpen)
  const contentFor = usePickerContent({ detail, employees, close, children, transitionTo, commitAssignee })

  // The panel above owns Escape and the sheet's Tab ring; while a picker is up
  // it has to stand down, so it needs to know.
  useEffect(() => onOpenChange(open !== null), [open, onOpenChange])

  const rowFor = useCallback((key: PeekPickerKey): PeekPickerRow => ({
    onOpen: () => setOpen((current) => (current === key ? null : key)),
    open: open === key,
    picker: !sheet && open === key && detail ? (
      <PickerPopover
        label={PICKER_TITLE[key]}
        onClose={close}
        autoFocusFirst={key !== 'assignee'}
        testId={`peek-picker-${key}`}
      >
        {contentFor(key, false)}
      </PickerPopover>
    ) : null,
  }), [detail, open, sheet, close, contentFor])

  const pickerSheet = sheet && open && detail ? (
    <PickerSheet title={PICKER_TITLE[open]} onClose={close} testId={`peek-picker-sheet-${open}`}>
      {contentFor(open, true)}
    </PickerSheet>
  ) : null

  return { rowFor, pickerSheet, error: refusal.message }
}
