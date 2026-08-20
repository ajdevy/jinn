import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { layoutFor } from './grid-layout'

interface ChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  width: number
  height: number
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  renderPane: (sessionId: string, active: boolean) => ReactNode
}

interface PaneFrameProps {
  sessionId: string
  active: boolean
  singlePane: boolean
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  children: ReactNode
}

function PaneFrame({ sessionId, active, singlePane, onFocus, onRemove, children }: PaneFrameProps) {
  return (
    <section
      data-testid={`pane-${sessionId}`}
      data-grid-active={String(active)}
      onClick={() => onFocus(sessionId)}
      className={`relative flex min-h-0 min-w-0 overflow-hidden ${singlePane ? 'flex-1' : 'rounded-[var(--radius-lg)]'}`}
    >
      {!singlePane && (
        <button
          type="button"
          aria-label={`Close ${sessionId}`}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(sessionId)
          }}
          className="absolute right-[var(--space-2)] top-[var(--space-2)] z-20 grid size-7 place-items-center rounded-full border-0 bg-[var(--fill-tertiary)] text-[var(--text-secondary)] shadow-none hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      )}
      {children}
    </section>
  )
}

export function ChatGrid({
  sessionIds,
  focusedId,
  width,
  height,
  onFocus,
  onRemove,
  renderPane,
}: ChatGridProps) {
  const layout = layoutFor(sessionIds.length, width, height)
  const singlePane = sessionIds.length <= 1

  return (
    <div
      data-testid="chat-grid"
      data-columns={layout.columns}
      data-rows={layout.rows}
      data-single-pane={String(singlePane)}
      className={singlePane
        ? 'flex min-h-0 flex-1 overflow-hidden'
        : 'grid min-h-0 flex-1 gap-[var(--space-2)] overflow-hidden bg-[var(--fill-quaternary)] p-[var(--space-2)]'}
      style={singlePane ? undefined : {
        gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
      }}
    >
      {sessionIds.map((sessionId) => (
        <PaneFrame
          key={sessionId}
          sessionId={sessionId}
          active={sessionId === focusedId}
          singlePane={singlePane}
          onFocus={onFocus}
          onRemove={onRemove}
        >
          {renderPane(sessionId, sessionId === focusedId)}
        </PaneFrame>
      ))}
    </div>
  )
}
