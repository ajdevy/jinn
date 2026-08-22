import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MultiChatGrid } from '../multi-chat-grid'

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId }: { sessionId: string | null }) => <output>{sessionId ?? 'new'}</output>,
}))

type GridProps = ComponentProps<typeof MultiChatGrid>

const noop = vi.fn()

function gridProps(overrides: Partial<GridProps> = {}): GridProps {
  return {
    sessionIds: ['a'],
    focusedId: 'a',
    primary: {
      paneKey: 'a',
      sessionId: 'a',
      pendingUserMessage: undefined,
      initialEmployee: undefined,
      onSessionCreated: noop,
      viewMode: 'chat',
      focusTrigger: 0,
      delegatedActivity: undefined,
    },
    viewport: { width: 1440, height: 900, mobile: false },
    metaById: {},
    sessionTitleFor: () => undefined,
    runtime: { portalName: 'Gateway', subscribe: () => noop, events: [] },
    scrollTopFor: () => undefined,
    viewModeFor: () => 'chat',
    focusTriggerFor: () => 0,
    delegatedActivityFor: () => undefined,
    onFocus: noop,
    onRemove: noop,
    onMeta: noop,
    onNewMeta: noop,
    onOpenFile: noop,
    onPeek: noop,
    onNewChat: noop,
    onRefresh: noop,
    onShortcutsClick: noop,
    onContentReady: noop,
    onStartFreshChat: async () => {},
    ...overrides,
  }
}

const PHONE = { width: 390, height: 844, mobile: true }

function crossfade(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-mobile-thread-pane]')
}

describe('MultiChatGrid close labels', () => {
  it('prefers live metadata and replaces UUID-only titles with the generic label', () => {
    const uuidTitle = '00000000-0000-0000-0000-000000000000'
    render(<MultiChatGrid {...gridProps({
      sessionIds: ['a', 'b'],
      metaById: {
        a: { sessionId: 'a', title: 'Live release plan' },
        b: { sessionId: 'b', title: uuidTitle },
      },
      sessionTitleFor: (id) => id === 'a' ? 'Stale release plan' : uuidTitle,
    })} />)

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

describe('mobile transcript cross-fade', () => {
  it('fades opacity only, on the motion tokens, with a reduced-motion escape', () => {
    render(<MultiChatGrid {...gridProps({ viewport: PHONE })} />)

    const wrapper = crossfade()
    expect(wrapper).toBeTruthy()
    expect(wrapper!.className).toContain(
      'animate-[jinn-mobile-chat-crossfade_var(--duration-base)_var(--ease-smooth)]',
    )
    expect(wrapper!.className).toContain('motion-reduce:animate-none')
    // A slide would fight the strip, which does not move.
    expect(wrapper!.className).not.toMatch(/translate|slide/)
  })

  it('keys on the committed pane rather than the chat the URL has moved on to', () => {
    // Mid-switch: the URL already names 'b', and selection-commit is still
    // holding 'a' on screen. The fade must not start until 'b' commits.
    const { rerender } = render(<MultiChatGrid {...gridProps({
      viewport: PHONE, sessionIds: ['a'], focusedId: 'a', primary: { ...gridProps().primary, paneKey: 'a', sessionId: 'a' },
    })} />)
    const held = crossfade()

    expect(held!.dataset.mobileThreadPane).toBe('a')
    expect(screen.getByText('a')).toBeTruthy()

    rerender(<MultiChatGrid {...gridProps({
      viewport: PHONE, sessionIds: ['b'], focusedId: 'b', primary: { ...gridProps().primary, paneKey: 'b', sessionId: 'b' },
    })} />)
    const committed = crossfade()

    // A new node is what replays the fade; content is on screen either side of
    // the switch, so nothing paints an empty transcript between the two chats.
    expect(committed!.dataset.mobileThreadPane).toBe('b')
    expect(committed).not.toBe(held)
    expect(screen.getByText('b')).toBeTruthy()
  })

  it('leaves the desktop grid unwrapped', () => {
    render(<MultiChatGrid {...gridProps()} />)

    expect(crossfade()).toBeNull()
    expect(screen.getByTestId('chat-grid')).toBeTruthy()
  })
})
