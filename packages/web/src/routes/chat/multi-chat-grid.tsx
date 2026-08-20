import type { ComponentProps } from 'react'
import { ChatPane } from '@/components/chat/chat-pane'
import { FileOpenContext } from '@/components/chat/file-open-context'
import type { CommsPeekData } from '@/components/chat/thread-peek'
import type { DelegatedActivity } from '@/lib/api'
import type { ViewMode } from '@/lib/view-mode'
import { ChatGrid } from './chat-grid'
import type { SessionMeta } from './use-chat-pane-state'

type PaneProps = ComponentProps<typeof ChatPane>
type PaneMetaUpdate = Parameters<NonNullable<PaneProps['onSessionMetaChange']>>[0]
type PaneRuntime = Pick<PaneProps, 'portalName' | 'subscribe' | 'engineRegistry' | 'connectionSeq' | 'skillsVersion' | 'events'>

interface MultiChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  viewport: { width: number; height: number }
  metaById: Record<string, SessionMeta>
  runtime: PaneRuntime
  scrollTopFor: (sessionId: string) => number | undefined
  viewModeFor: (sessionId: string) => ViewMode
  focusTriggerFor: (sessionId: string) => number
  delegatedActivityFor: (sessionId: string) => DelegatedActivity | null | undefined
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  onMeta: (sessionId: string, meta: PaneMetaUpdate) => void
  onOpenFile: (sessionId: string, path: string) => void
  onPeek: (sessionId: string, peek: CommsPeekData) => void
  onNewChat: PaneProps['onNewChat']
  onRefresh: PaneProps['onRefresh']
  onShortcutsClick: PaneProps['onShortcutsClick']
  onContentReady: PaneProps['onContentReady']
  onStartFreshChat: PaneProps['onStartFreshChat']
}

export function MultiChatGrid(props: MultiChatGridProps) {
  return (
    <ChatGrid
      sessionIds={props.sessionIds}
      focusedId={props.focusedId}
      width={props.viewport.width}
      height={props.viewport.height}
      onFocus={props.onFocus}
      onRemove={props.onRemove}
      renderPane={(sessionId, active) => {
        const meta = props.metaById[sessionId]
        const cliAvailable = !meta?.engine || props.runtime.engineRegistry?.engines?.[meta.engine]?.supportsPty === true
        return (
          <FileOpenContext.Provider value={(path) => props.onOpenFile(sessionId, path)}>
            <ChatPane
              {...props.runtime}
              sessionId={sessionId}
              initialScrollTop={props.scrollTopFor(sessionId)}
              isActive={active}
              onFocus={() => props.onFocus(sessionId)}
              onNewChat={props.onNewChat}
              onSessionMetaChange={(update) => props.onMeta(sessionId, update)}
              onRefresh={props.onRefresh}
              viewMode={cliAvailable ? props.viewModeFor(sessionId) : 'chat'}
              focusTrigger={props.focusTriggerFor(sessionId)}
              onShortcutsClick={props.onShortcutsClick}
              onPeek={(peek) => props.onPeek(sessionId, peek)}
              onContentReady={props.onContentReady}
              delegatedActivity={props.delegatedActivityFor(sessionId)}
              onStartFreshChat={props.onStartFreshChat}
            />
          </FileOpenContext.Provider>
        )
      }}
    />
  )
}
