import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatHeaderMenu } from '../chat-header-menu'

const pinState = vi.hoisted(() => ({
  keys: new Set<string>(),
  mutate: vi.fn(),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: pinState.keys }),
  useTogglePin: () => ({ mutate: pinState.mutate }),
}))

const SESSION_ID = 'session-1'

function renderMenu(overrides: Partial<Parameters<typeof ChatHeaderMenu>[0]> = {}) {
  return render(
    <ChatHeaderMenu
      open
      onOpenChange={vi.fn()}
      selectedId={SESSION_ID}
      sessionMeta={{ engine: 'claude' }}
      openGlobalSearch={vi.fn()}
      effectiveViewMode="chat"
      cliModeAvailable
      viewSwitchLocked={false}
      cliTitle={undefined}
      setAndPersistViewMode={vi.fn()}
      onDuplicate={vi.fn()}
      duplicatePending={false}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onCopyToClipboard={vi.fn()}
      onShareDebugLog={vi.fn()}
      onClearDebugLog={vi.fn()}
      onDeleteSession={vi.fn()}
      onOpenChatBeside={vi.fn()}
      {...overrides}
    />,
  )
}

function itemLabels() {
  return screen.getAllByRole('button').map((button) => button.textContent?.trim())
}

beforeEach(() => {
  pinState.keys = new Set<string>()
  pinState.mutate = vi.fn()
})

describe('ChatHeaderMenu', () => {
  it('renders Pin directly above Duplicate and pins the selected session', () => {
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Pin')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Pin')).toBe(labels.indexOf('Duplicate...') - 1)

    fireEvent.click(screen.getByText('Pin'))
    expect(pinState.mutate).toHaveBeenCalledWith({ key: SESSION_ID, pinned: true })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reads Unpin and unpins when the session is already pinned', () => {
    pinState.keys = new Set([SESSION_ID])
    renderMenu()

    expect(screen.queryByText('Pin')).toBeNull()
    fireEvent.click(screen.getByText('Unpin'))
    expect(pinState.mutate).toHaveBeenCalledWith({ key: SESSION_ID, pinned: false })
  })

  it('renders no pin item without a selected session, like Duplicate and Archive', () => {
    renderMenu({ selectedId: null })

    expect(screen.queryByText('Pin')).toBeNull()
    expect(screen.queryByText('Unpin')).toBeNull()
    expect(screen.queryByText('Duplicate...')).toBeNull()
    expect(screen.queryByText('Archive chat')).toBeNull()
  })

  it('opens a picker pane beside the current chat and closes the menu', () => {
    const onOpenChatBeside = vi.fn()
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChatBeside, onOpenChange })

    fireEvent.click(screen.getByRole('button', { name: 'Open chat beside' }))

    expect(onOpenChatBeside).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
