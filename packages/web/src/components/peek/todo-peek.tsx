import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ChevronDown, MessageSquare, UserRound } from 'lucide-react'
import { api, type Employee, type WorkItemEventWire, type WorkItemFullWire } from '@/lib/api'
import { STATUS_LABEL, priorityLabel } from '@/lib/todos'
import { todoPath } from '@/lib/todo-id'
import { requestTodoPreview } from '@/lib/todo-preview'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { TodoMention } from '@/components/todo-mention'
import { useOrg } from '@/hooks/use-employees'
import { StatusCircle } from '@/routes/todos/state-glyph'
import { useEmployeesByName } from '@/routes/todos/use-todos'
import { whisperOf } from '@/routes/todos/task-page/activity'
import { RailPriorityBars } from '@/routes/todos/task-page/props-rail'
import { displayNameOf, formatRelativeTime } from '@/routes/todos/util'

/* The Todo body of the peek inspector. Read-only by design: Status and Assignee
 * carry the chevron that says "this is where you will change it", but the seam
 * behind it belongs to ICI-743. The detail sits under the ['work-item-preview',
 * id] key the invalidation wiring already watches, so a company:changed event
 * for this Todo refetches the open panel. */

/** The three newest events, newest first: this is a glance, not the feed. */
export function latestEvents(events: WorkItemEventWire[]): WorkItemEventWire[] {
  return events.slice(-3).reverse()
}

/** The parent's title comes from the mention batch cache rather than a second
 *  detail fetch. Until it resolves the row is the id alone, which is still true. */
function useParentTitle(parentId: string | null | undefined): string | null {
  const [title, setTitle] = useState<string | null>(null)

  useEffect(() => {
    setTitle(null)
    if (!parentId) return
    let cancelled = false
    // A failed warm leaves the row as the bare id; the mention anchor beside it
    // is what re-asks, so swallowing here only keeps it off the console.
    requestTodoPreview(parentId)
      .then((preview) => { if (!cancelled) setTitle(preview?.workItem.title ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [parentId])

  return title
}

function PropRow({ label, chevron, children }: { label: string; chevron?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-center" data-testid={`peek-prop-${label.toLowerCase()}`}>
      <span className="w-[86px] flex-none text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</span>
      <span className="-ml-[9px] inline-flex min-w-0 items-center gap-[7px] rounded-[var(--radius-md)] px-[9px] py-[5px] text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        {children}
        {chevron && <ChevronDown size={11} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)] opacity-45" />}
      </span>
    </div>
  )
}

function TodoProps({ item, byName, parentTitle }: {
  item: WorkItemFullWire
  byName: Map<string, Employee>
  parentTitle: string | null
}) {
  return (
    <div className="mt-[var(--space-4)] flex flex-col gap-0.5">
      <PropRow label="Status" chevron>
        <StatusCircle status={item.status} size={18} />
        {STATUS_LABEL[item.status]}
      </PropRow>
      <PropRow label="Assignee" chevron>
        {item.assignee ? (
          <>
            <EmployeeAvatar name={item.assignee} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
            {displayNameOf(item.assignee, byName)}
          </>
        ) : (
          <>
            <span className="grid size-[18px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-quaternary)]">
              <UserRound size={10} aria-hidden />
            </span>
            <span className="text-[var(--text-tertiary)]">Unassigned</span>
          </>
        )}
      </PropRow>
      <PropRow label="Priority">
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </PropRow>
      <PropRow label="Parent">
        {item.parentId ? (
          <>
            <TodoMention id={item.parentId} />
            {parentTitle && <span className="truncate">{parentTitle}</span>}
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">No parent</span>
        )}
      </PropRow>
    </div>
  )
}

function ActivityRow({ event, live }: { event: WorkItemEventWire; live: boolean }) {
  const whisper = whisperOf(event)
  return (
    <div className="flex items-start gap-[9px] text-[length:var(--text-footnote)] leading-[1.4] text-[var(--text-secondary)]">
      {live ? (
        <span
          aria-hidden
          data-testid="peek-activity-pulse"
          className="mt-1.5 size-1.5 flex-none rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
        />
      ) : (
        <span aria-hidden className="mt-[3px] grid size-[18px] flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]">
          <whisper.Icon size={10} strokeWidth={2.2} />
        </span>
      )}
      <span className="min-w-0 flex-1">{whisper.text}</span>
      <span className="ml-auto flex-none text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
        {formatRelativeTime(event.createdAt)}
      </span>
    </div>
  )
}

function TodoActivity({ events, executing }: { events: WorkItemEventWire[]; executing: boolean }) {
  return (
    <>
      <h3 className="mt-[var(--space-4)] text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.06em] text-[var(--text-quaternary)]">
        Latest
      </h3>
      <div className="mt-[var(--space-2)] flex flex-col gap-2.5" data-testid="peek-activity">
        {/* "The active one" is live work, not merely the most recent row. */}
        {latestEvents(events).map((event, index) => (
          <ActivityRow key={event.id} event={event} live={index === 0 && executing} />
        ))}
      </div>
    </>
  )
}

const FOOTER_BUTTON =
  'focus-ring inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--fill-secondary)] text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] outline-none transition-colors duration-150 hover:bg-[var(--fill-tertiary)]'

const QUIET_LINE = 'flex-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]'

export function TodoPeek({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['work-item-preview', id],
    queryFn: () => api.getWorkItem(id),
  })
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const parentTitle = useParentTitle(detail.data?.workItem.parentId)

  if (detail.isPending) return <p className={QUIET_LINE}>Loading {id}…</p>
  if (!detail.data) {
    return (
      <p className={QUIET_LINE} data-testid="peek-error">
        Couldn&apos;t load {id}. It may have been deleted — open it full to check.
      </p>
    )
  }

  const item = detail.data.workItem
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="peek-todo">
        <h2 className="text-[length:var(--text-title3)] font-semibold leading-[1.25] tracking-[-0.4px] text-[var(--text-primary)]">
          {item.title}
        </h2>
        {item.body && (
          <p className="mt-[var(--space-3)] line-clamp-3 text-[length:var(--text-subheadline)] leading-[1.5] text-[var(--text-secondary)]">
            {item.body}
          </p>
        )}
        <TodoProps item={item} byName={byName} parentTitle={parentTitle} />
        <TodoActivity events={detail.data.events} executing={item.status === 'executing'} />
      </div>

      <div className="flex flex-none gap-[var(--space-2)] pt-[var(--space-4)]">
        <Link to={todoPath(id)} className={FOOTER_BUTTON}>
          <MessageSquare size={14} strokeWidth={2} aria-hidden />
          Comment
        </Link>
        <Link to={todoPath(id)} className={FOOTER_BUTTON}>
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
          Open full
        </Link>
      </div>
    </>
  )
}
