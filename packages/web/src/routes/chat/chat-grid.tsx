import type { ReactNode, RefCallback } from 'react'
import { layoutFor } from './grid-layout'
import { useChatGridMotion } from './use-chat-grid-motion'

interface ChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  width: number
  height: number
  onFocus: (sessionId: string) => void
  renderPane: (sessionId: string, active: boolean) => ReactNode
}

interface PaneFrameProps {
  sessionId: string
  active: boolean
  singlePane: boolean
  onFocus: (sessionId: string) => void
  paneRef: RefCallback<HTMLElement>
  children: ReactNode
}

function PaneFrame({ sessionId, active, singlePane, onFocus, paneRef, children }: PaneFrameProps) {
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
          onFocus={onFocus}
          paneRef={motion.paneRef(sessionId)}
        >
          {renderPane(sessionId, sessionId === focusedId)}
        </PaneFrame>
      ))}
    </div>
  )
}
