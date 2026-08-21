import type { ComponentProps } from 'react'
import { ChatPane } from '@/components/chat/chat-pane'
import { FileOpenContext } from '@/components/chat/file-open-context'
import type { CommsPeekData } from '@/components/chat/thread-peek'
import type { DelegatedActivity } from '@/lib/api'
import type { ViewMode } from '@/lib/view-mode'
import { ChatGrid } from './chat-grid'
import { SessionPicker } from './session-picker'
import type { SessionMeta } from './use-chat-pane-state'

type PaneProps = ComponentProps<typeof ChatPane>
type PaneMetaUpdate = Parameters<NonNullable<PaneProps['onSessionMetaChange']>>[0]
type PaneRuntime = Pick<PaneProps, 'portalName' | 'subscribe' | 'engineRegistry' | 'connectionSeq' | 'skillsVersion' | 'events'>

interface MultiChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  primary: {
    paneKey: string
    sessionId: string | null
    pendingUserMessage: PaneProps['pendingUserMessage']
    initialEmployee: PaneProps['initialEmployee']
    onSessionCreated: PaneProps['onSessionCreated']
    viewMode: ViewMode
    focusTrigger: number
    delegatedActivity: DelegatedActivity | null | undefined
  }
  viewport: { width: number; height: number; mobile?: boolean }
  metaById: Record<string, SessionMeta>
  sessionTitleFor: (sessionId: string) => unknown
  runtime: PaneRuntime
  scrollTopFor: (sessionId: string) => number | undefined
  viewModeFor: (sessionId: string) => ViewMode
  focusTriggerFor: (sessionId: string) => number
  delegatedActivityFor: (sessionId: string) => DelegatedActivity | null | undefined
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  onMeta: (sessionId: string, meta: PaneMetaUpdate) => void
  onNewMeta: (meta: PaneMetaUpdate) => void
  onOpenFile: (sessionId: string, path: string) => void
  onPeek: (sessionId: string, peek: CommsPeekData) => void
  onNewChat: PaneProps['onNewChat']
  onRefresh: PaneProps['onRefresh']
  onShortcutsClick: PaneProps['onShortcutsClick']
  onContentReady: PaneProps['onContentReady']
  onStartFreshChat: PaneProps['onStartFreshChat']
  pickerPane?: {
    paneKey: string
    onPick: (sessionId: string) => void
    onSessionCreated: NonNullable<PaneProps['onSessionCreated']>
    onClose: () => void
  }
}

function sessionForGridId(props: MultiChatGridProps, gridId: string): string | null {
  if (gridId === props.primary.paneKey) return props.primary.sessionId
  return gridId === props.pickerPane?.paneKey ? null : gridId
}

function viewModeForPane(owner: MultiChatGridProps, sessionId: string | null, cliAvailable: boolean): ViewMode {
  if (!sessionId) return owner.primary.viewMode
  return cliAvailable ? owner.viewModeFor(sessionId) : 'chat'
}

function focusTriggerForPane(owner: MultiChatGridProps, sessionId: string | null): number {
  return sessionId ? owner.focusTriggerFor(sessionId) : owner.primary.focusTrigger
}

function delegatedActivityForPane(owner: MultiChatGridProps, sessionId: string | null) {
  return sessionId ? owner.delegatedActivityFor(sessionId) : owner.primary.delegatedActivity
}

function updatePaneMeta(owner: MultiChatGridProps, sessionId: string | null, update: PaneMetaUpdate): void {
  // The payload wins: a pane can change identity without remounting (composer
  // adoption), so the id captured in this closure may already be a step behind.
  const owningId = update.sessionId || sessionId
  if (owningId) owner.onMeta(owningId, update)
  else owner.onNewMeta(update)
}

function paneScrollTop(owner: MultiChatGridProps, sessionId: string | null): number | undefined {
  return sessionId ? owner.scrollTopFor(sessionId) : undefined
}

function panePeek(owner: MultiChatGridProps, sessionId: string | null): PaneProps['onPeek'] {
  return sessionId ? (peek) => owner.onPeek(sessionId, peek) : undefined
}

function paneCliAvailable(owner: MultiChatGridProps, sessionId: string | null): boolean {
  const engine = sessionId ? owner.metaById[sessionId]?.engine : undefined
  return !engine || owner.runtime.engineRegistry?.engines?.[engine]?.supportsPty === true
}

const UUID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i

function safePaneTitle(value: unknown): string | undefined {
  const title = typeof value === 'string' ? value.trim() : ''
  return title && !UUID_PATTERN.test(title) ? title : undefined
}

function closeLabelForGridId(owner: MultiChatGridProps, gridId: string): string {
  const sessionId = sessionForGridId(owner, gridId)
  if (!sessionId) return 'Close chat'
  const title = safePaneTitle(owner.metaById[sessionId]?.title)
    ?? safePaneTitle(owner.sessionTitleFor(sessionId))
  return title ? `Close ${title}` : 'Close chat'
}

function GridChatPane({
  gridId,
  active,
  owner,
}: {
  gridId: string
  active: boolean
  owner: MultiChatGridProps
}) {
  const sessionId = sessionForGridId(owner, gridId)
  const primary = gridId === owner.primary.paneKey
  const pickerPane = gridId === owner.pickerPane?.paneKey ? owner.pickerPane : undefined
  const cliAvailable = paneCliAvailable(owner, sessionId)
  const pane = (
    <ChatPane
      {...owner.runtime}
      sessionId={sessionId}
      initialScrollTop={paneScrollTop(owner, sessionId)}
      initialEmployee={primary ? owner.primary.initialEmployee : undefined}
      isActive={active}
      onFocus={() => { if (sessionId) owner.onFocus(sessionId) }}
      onSessionCreated={primary ? owner.primary.onSessionCreated : pickerPane?.onSessionCreated}
      onNewChat={owner.onNewChat}
      onSessionMetaChange={(update) => updatePaneMeta(owner, sessionId, update)}
      onRefresh={owner.onRefresh}
      viewMode={viewModeForPane(owner, sessionId, cliAvailable)}
      focusTrigger={focusTriggerForPane(owner, sessionId)}
      onShortcutsClick={owner.onShortcutsClick}
      pendingUserMessage={primary ? owner.primary.pendingUserMessage : undefined}
      onPeek={panePeek(owner, sessionId)}
      onContentReady={owner.onContentReady}
      delegatedActivity={delegatedActivityForPane(owner, sessionId)}
      onStartFreshChat={owner.onStartFreshChat}
      newChatEmptyState={pickerPane ? <SessionPicker onPick={pickerPane.onPick} /> : undefined}
    />
  )
  return (
    <FileOpenContext.Provider value={(path) => { if (sessionId) owner.onOpenFile(sessionId, path) }}>
      {pane}
    </FileOpenContext.Provider>
  )
}

export function MultiChatGrid(props: MultiChatGridProps) {
  const primaryKey = props.primary.paneKey
  const sessionGridIds = props.primary.sessionId
    ? props.sessionIds.map((sessionId) => sessionId === props.primary.sessionId ? primaryKey : sessionId)
    : props.sessionIds.length === 1
      ? [primaryKey]
      : [...props.sessionIds, primaryKey]
  const mobilePickerKey = props.viewport.mobile ? props.pickerPane?.paneKey : undefined
  const gridIds = mobilePickerKey
    ? [mobilePickerKey]
    : props.pickerPane ? [...sessionGridIds, props.pickerPane.paneKey] : sessionGridIds
  const focusedGridId = mobilePickerKey ?? (
    !props.primary.sessionId || props.focusedId === props.primary.sessionId
      ? primaryKey
      : props.focusedId
  )

  return (
    <ChatGrid
      sessionIds={gridIds}
      focusedId={focusedGridId}
      width={props.viewport.width}
      height={props.viewport.height}
      labelFor={(gridId) => closeLabelForGridId(props, gridId)}
      onFocus={(gridId) => {
        const sessionId = sessionForGridId(props, gridId)
        if (sessionId) props.onFocus(sessionId)
      }}
      onRemove={(gridId) => {
        if (gridId === props.pickerPane?.paneKey) {
          props.pickerPane.onClose()
          return
        }
        const sessionId = sessionForGridId(props, gridId)
        if (sessionId) props.onRemove(sessionId)
      }}
      renderPane={(gridId, active) => <GridChatPane gridId={gridId} active={active} owner={props} />}
    />
  )
}
