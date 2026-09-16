import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatHeaderMenu } from '../chat-header-menu'
import { installPlatform } from '@/platform'
import { createPlatform, type Runtime } from '@/platform/contracts'
import { createTestAdapter, type TestAdapter } from '@/platform/adapters/test'

const pinState = vi.hoisted(() => ({
  keys: new Set<string>(),
  mutate: vi.fn(),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: pinState.keys }),
  useTogglePin: () => ({ mutate: pinState.mutate }),
}))

const SESSION_ID = 'session-1'

const runtime: Runtime = {
  container: 'browser',
  os: 'unknown',
  engine: 'unknown',
  secureContext: true,
  appVersion: 'test',
  userAgent: 'chat-header-menu-test',
}

let platform: TestAdapter
let restorePlatform: () => void

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
  platform = createTestAdapter({ results: { 'navigation.open-external': { status: 'performed' } } })
  restorePlatform = installPlatform(createPlatform({ runtime, adapters: [platform] }))
})

afterEach(() => {
  restorePlatform()
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
    expect(screen.queryByText('Open in new tab')).toBeNull()
  })

  it('opens a picker pane beside the current chat and closes the menu', () => {
    const onOpenChatBeside = vi.fn()
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChatBeside, onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Open beside')).toBe(labels.indexOf('CLI') + 1)
    expect(labels.indexOf('Open beside')).toBe(labels.indexOf('Open in new tab') - 1)
    fireEvent.click(screen.getByRole('button', { name: 'Open beside' }))

    expect(onOpenChatBeside).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the selected chat in its own tab through the platform and closes the menu', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Open in new tab')).toBe(labels.indexOf('Open beside') + 1)
    expect(labels.indexOf('Open in new tab')).toBe(labels.indexOf('Pin') - 1)

    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))

    await waitFor(() => expect(platform.calls).toHaveLength(1))
    const [intent] = platform.calls
    expect(intent.kind).toBe('navigation.open-external')
    const target = new URL((intent as Extract<typeof intent, { kind: 'navigation.open-external' }>).url)
    expect(`${target.pathname}${target.search}`).toBe(`/?session=${encodeURIComponent(SESSION_ID)}`)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
