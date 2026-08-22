import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { emojiForName } from '@/lib/emoji-pool'
import { ChatPaneTitleBar } from '../chat-pane-title-bar'

describe('ChatPaneTitleBar', () => {
  it('renders pane identity with a quiet id and a stable trailing cluster', () => {
    render(
      <ChatPaneTitleBar
        title="#42 - Release planning"
        employee="platform-lead"
        session={{ id: 'a', status: 'idle' }}
        onClose={vi.fn()}
      />,
    )

    const bar = screen.getByTestId('chat-pane-title-bar')
    expect(bar.className).toContain('h-[34px]')
    expect(screen.getByText(emojiForName('platform-lead'))).toBeTruthy()
    expect(screen.getByText('#42').className).toContain('text-[var(--text-tertiary)]')
    expect(bar.className).toContain('text-[var(--text-secondary)]')
    expect(screen.getByText('Release planning').closest('[title]')?.getAttribute('title')).toBe('#42 - Release planning')
    expect(screen.getByTestId('chat-pane-title-actions').className).toContain('w-[52px]')
  })

  it.each([
    ['running', { id: 'a', status: 'running' }, 'var(--system-blue)', true],
    ['background', { id: 'b', status: 'idle', backgroundActivity: { activeStreams: 1, lastActivityAt: new Date().toISOString() } }, 'var(--system-orange)', true],
  ] as const)('renders the %s state with the shared status dot', (_name, session, color, pulse) => {
    render(<ChatPaneTitleBar title="Status pane" employee="operator" session={session} onClose={vi.fn()} />)

    const dot = screen.getByTestId('chat-pane-status-dot')
    expect(dot.getAttribute('style')).toContain(`background: ${color}`)
    expect(dot.className.includes('animate-sidebar-pulse')).toBe(pulse)
  })

  it('renders no dot for a resting read pane', () => {
    render(<ChatPaneTitleBar title="Resting pane" employee="operator" session={{ id: 'a', status: 'idle' }} onClose={vi.fn()} />)

    expect(screen.queryByTestId('chat-pane-status-dot')).toBeNull()
  })

  it('reveals a pane-labelled close control without bubbling pane focus', () => {
    const onClose = vi.fn()
    const onPaneClick = vi.fn()
    render(
      <div onClick={onPaneClick}>
        <ChatPaneTitleBar
          title="Release planning"
          employee="platform-lead"
          session={{ id: 'a', status: 'idle' }}
          onClose={onClose}
        />
      </div>,
    )

    const close = screen.getByRole('button', { name: 'Close Release planning' })
    expect(screen.getByTestId('chat-pane-title-actions').firstElementChild?.className).toContain('group-focus-within/title-actions:opacity-0')
    expect(close.className).toContain('group-hover/chat-pane:opacity-100')
    expect(close.className).toContain('focus-visible:opacity-100')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onPaneClick).not.toHaveBeenCalled()
  })
})
