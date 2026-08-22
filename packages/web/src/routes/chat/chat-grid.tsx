import type { ReactNode, RefCallback } from 'react'
import { X } from 'lucide-react'
import { layoutFor } from './grid-layout'
import { useChatGridMotion } from './use-chat-grid-motion'

const UUID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i

function safeCloseLabel(value: string | undefined): string {
  const label = value?.trim()
  return label && !UUID_PATTERN.test(label) ? label : 'Close chat'
}

interface ChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  width: number
  height: number
  labelFor?: (sessionId: string) => string
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  renderPane: (sessionId: string, active: boolean) => ReactNode
}

interface PaneFrameProps {
  sessionId: string
  active: boolean
  singlePane: boolean
  label: string
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  paneRef: RefCallback<HTMLElement>
  children: ReactNode
}

function PaneFrame({ sessionId, active, singlePane, label, onFocus, onRemove, paneRef, children }: PaneFrameProps) {
  return (
    <section
      ref={paneRef}
      data-testid={`pane-${sessionId}`}
      data-chat-grid-pane={sessionId}
      data-grid-active={String(active)}
      data-grid-motion="idle"
      onClick={() => onFocus(sessionId)}
      className={`relative flex min-h-0 min-w-0 origin-top-left overflow-hidden ${singlePane ? 'flex-1' : 'rounded-[var(--radius-lg)]'}`}
    >
      {!singlePane && (
        <button
          type="button"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(sessionId)
          }}
          className="absolute right-[var(--space-2)] top-[58px] z-20 grid size-7 place-items-center rounded-full border-0 bg-[var(--fill-tertiary)] text-[var(--text-secondary)] shadow-none hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
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
  labelFor,
  onFocus,
  onRemove,
  renderPane,
}: ChatGridProps) {
  const layout = layoutFor(sessionIds.length, width, height)
  const singlePane = sessionIds.length <= 1
  const motion = useChatGridMotion(sessionIds)

  return (
    <div
      ref={motion.gridRef}
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
          label={safeCloseLabel(labelFor?.(sessionId))}
          onFocus={onFocus}
          onRemove={onRemove}
          paneRef={motion.paneRef(sessionId)}
        >
          {renderPane(sessionId, sessionId === focusedId)}
        </PaneFrame>
      ))}
    </div>
  )
}
