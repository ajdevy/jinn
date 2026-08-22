import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { deriveChatGridIds, MultiChatGrid } from '../multi-chat-grid'

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId }: { sessionId: string | null }) => <output>{sessionId ?? 'new'}</output>,
}))

describe('chat grid placement', () => {
  it.each([
    {
      name: 'primary only', sessionIds: ['a'], primaryPaneKey: 'primary', primarySessionId: 'a',
      expected: ['primary'],
    },
    {
      name: 'picker open', sessionIds: ['a'], primaryPaneKey: 'primary', primarySessionId: 'a',
      pickerPaneKey: 'picker', expected: ['primary', 'picker'],
    },
    {
      name: 'picker and sessions', sessionIds: ['a', 'b'], primaryPaneKey: 'primary', primarySessionId: 'a',
      pickerPaneKey: 'picker', expected: ['primary', 'b', 'picker'],
    },
    {
      name: 'sessionless primary and picker', sessionIds: ['a', 'b'], primaryPaneKey: 'composer', primarySessionId: null,
      pickerPaneKey: 'picker', expected: ['a', 'b', 'composer', 'picker'],
    },
  ])('matches the panes MultiChatGrid renders for $name', (input) => {
    const noop = vi.fn()
    const pickerPane = input.pickerPaneKey ? {
      paneKey: input.pickerPaneKey,
      onPick: noop,
      onSessionCreated: noop,
      onClose: noop,
    } : undefined
    const view = render(
      <MultiChatGrid
        sessionIds={input.sessionIds}
        focusedId={input.primarySessionId}
        primary={{
          paneKey: input.primaryPaneKey,
          sessionId: input.primarySessionId,
          pendingUserMessage: undefined,
          initialEmployee: undefined,
          onSessionCreated: noop,
          viewMode: 'chat',
          focusTrigger: 0,
          delegatedActivity: undefined,
        }}
        viewport={{ width: 1440, height: 900 }}
        metaById={{}}
        sessionTitleFor={() => undefined}
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
        pickerPane={pickerPane}
      />,
    )

    const derived = deriveChatGridIds(input)
    const rendered = Array.from(view.container.querySelectorAll('[data-chat-grid-pane]'), (pane) => (
      pane.getAttribute('data-chat-grid-pane')
    ))
    expect(derived).toEqual(input.expected)
    expect(rendered).toEqual(derived)
    view.unmount()
  })
})

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

  it('appends a session-less primary pane after every live session pane', () => {
    const noop = vi.fn()
    render(
      <MultiChatGrid
        sessionIds={['a', 'b']}
        focusedId="a"
        primary={{
          paneKey: 'composer',
          sessionId: null,
          pendingUserMessage: undefined,
          initialEmployee: undefined,
          onSessionCreated: noop,
          viewMode: 'chat',
          focusTrigger: 0,
          delegatedActivity: undefined,
        }}
        viewport={{ width: 1440, height: 900 }}
        metaById={{}}
        sessionTitleFor={() => undefined}
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

    expect(Array.from(document.querySelectorAll('[data-chat-grid-pane]')).map((pane) => (
      pane.getAttribute('data-chat-grid-pane')
    ))).toEqual(['a', 'b', 'composer'])
  })

  it('shows an open picker as the only pane on mobile', () => {
    const noop = vi.fn()
    render(
      <MultiChatGrid
        sessionIds={['a']}
        focusedId="a"
        primary={{ paneKey: 'a', sessionId: 'a', pendingUserMessage: undefined, initialEmployee: undefined, onSessionCreated: noop, viewMode: 'chat', focusTrigger: 0, delegatedActivity: undefined }}
        viewport={{ width: 390, height: 844, mobile: true }}
        metaById={{}}
        sessionTitleFor={() => undefined}
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
        pickerPane={{ paneKey: 'picker', onPick: noop, onSessionCreated: noop, onClose: noop }}
      />,
    )

    expect(Array.from(document.querySelectorAll('[data-chat-grid-pane]')).map((pane) => (
      pane.getAttribute('data-chat-grid-pane')
    ))).toEqual(['picker'])
  })
})
