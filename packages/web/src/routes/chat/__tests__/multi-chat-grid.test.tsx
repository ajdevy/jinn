import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MultiChatGrid } from '../multi-chat-grid'

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId }: { sessionId: string | null }) => <output>{sessionId ?? 'new'}</output>,
}))

describe('MultiChatGrid close labels', () => {
  it('prefers live metadata and replaces UUID-only titles with the generic label', () => {
    const uuidTitle = '00000000-0000-0000-0000-000000000000'
    const noop = vi.fn()
    render(
      <MultiChatGrid
        sessionIds={['a', 'b']}
        focusedId="a"
        primary={{
          paneKey: 'a',
          sessionId: 'a',
          pendingUserMessage: undefined,
          initialEmployee: undefined,
          onSessionCreated: noop,
          viewMode: 'chat',
          focusTrigger: 0,
          delegatedActivity: undefined,
        }}
        viewport={{ width: 1440, height: 900 }}
        metaById={{
          a: { sessionId: 'a', title: 'Live release plan' },
          b: { sessionId: 'b', title: uuidTitle },
        }}
        sessionTitleFor={(id) => id === 'a' ? 'Stale release plan' : uuidTitle}
        runtime={{ portalName: 'Gateway', subscribe: () => noop, events: [] }}
        scrollTopFor={() => undefined}
        viewModeFor={() => 'chat'}
        focusTriggerFor={() => 0}
        delegatedActivityFor={() => undefined}
        onFocus={noop}
        onRemove={noop}
        onMeta={noop}
        onNewMeta={noop}
        onOpenFile={noop}
        onPeek={noop}
        onNewChat={noop}
        onRefresh={noop}
        onShortcutsClick={noop}
        onContentReady={noop}
        onStartFreshChat={async () => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Close Live release plan' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close chat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `Close ${uuidTitle}` })).toBeNull()
  })
})
