import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import {
  apiMocks,
  emit,
  gateway,
  pane,
  renderRoute,
  sessionIds,
  sessionTransfer,
} from './multi-pane-page-harness'

describe('the routed multi-pane surface', () => {
  const desktopWidth = 1440

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: desktopWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.sendMessage.mockClear()
    apiMocks.createSession.mockClear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
  })

  it('keeps four live transcripts isolated and preserves a streaming pane while a sibling closes', async () => {
    renderRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    await waitFor(() => sessionIds.forEach((id) => expect(pane(id).textContent).toContain(`transcript-${id}`)))

    fireEvent.click(pane('c'))
    await waitFor(() => expect(pane('c').getAttribute('data-chat-pane-active')).toBe('true'))
    await waitFor(() => expect(screen.getAllByText('Title c').length).toBeGreaterThan(0))

    const untouched = new Map(['a', 'b', 'd'].map((id) => [id, pane(id).textContent]))
    const textarea = pane('c').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'only-c-grows' } })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledWith('c', expect.objectContaining({ message: 'only-c-grows' })))
    expect(document.activeElement).toBe(textarea)
    for (const [id, text] of untouched) expect(pane(id).textContent).toBe(text)
    expect(pane('c').textContent?.match(/only-c-grows/g)).toHaveLength(1)

    const foregroundBeforeBackground = pane('c').textContent
    emit('session:delta', { sessionId: 'b', type: 'text', content: 'background-b' })
    await waitFor(() => expect(pane('b').textContent).toContain('background-b'))
    expect(pane('c').textContent).toBe(foregroundBeforeBackground)
    expect(pane('a').textContent).toBe(untouched.get('a'))
    expect(pane('d').textContent).toBe(untouched.get('d'))

    emit('session:delta', { sessionId: 'c', type: 'text', content: 'stream-c' })
    await waitFor(() => expect(pane('c').textContent).toContain('stream-c'))
    const streamingPane = screen.getByTestId('pane-c')
    const streamingChatPane = pane('c')
    const streamingText = pane('c').textContent

    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="b"]')).toBeNull())
    expect(screen.getByTestId('pane-c')).toBe(streamingPane)
    expect(pane('c')).toBe(streamingChatPane)
    expect(pane('c').textContent).toBe(streamingText)
    emit('session:delta', { sessionId: 'c', type: 'text', content: '-still-streaming' })
    await waitFor(() => expect(pane('c').textContent?.match(/still-streaming/g)).toHaveLength(1))
    expect(pane('c')).toBe(streamingChatPane)
    expect(pane('a').textContent).toContain('transcript-a')
    expect(pane('d').textContent).toContain('transcript-d')
  })

  it('paints the same live pane and persists the same set from drop and picker', async () => {
    const initial = JSON.stringify({
      version: 1,
      sessionIds: ['a', 'b'],
      focusedId: 'a',
      focusHistory: ['a', 'b'],
    })
    localStorage.setItem(WORKING_SET_STORAGE_KEY, initial)
    const dropped = renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(2))
    const surface = document.querySelector<HTMLElement>('[data-chat-grid-drop-surface]')!
    fireEvent.drop(surface, { dataTransfer: sessionTransfer('c') })
    await waitFor(() => expect(pane('c').textContent).toContain('transcript-c'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(['a', 'b', 'c']))
    const dropState = localStorage.getItem(WORKING_SET_STORAGE_KEY)
    dropped.unmount()

    gateway.listeners.clear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, initial)
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(2))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add chat to grid' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Title c' }))
    await waitFor(() => expect(pane('c').textContent).toContain('transcript-c'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(['a', 'b', 'c']))
    expect(localStorage.getItem(WORKING_SET_STORAGE_KEY)).toBe(dropState)
  })

  it('adds a second pane from the header action while keeping the original pane mounted', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const originalPane = pane('a')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add chat to grid' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Title b' }))

    await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))
    expect(pane('a')).toBe(originalPane)
  })

  it('replaces a lone chat with the composer instead of splitting New chat', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])

    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(screen.getByTestId('chat-grid').getAttribute('data-single-pane')).toBe('true')
    expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(1)
  })

  it('uses one capped pane for the composer and restores the folded member on dismiss and commit', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])

    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4)
    expect(document.querySelector('[data-chat-pane-session="b"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(sessionIds)

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
    await waitFor(() => expect(pane('a')).toBeDefined())
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    expect(pane('b')).toBeDefined()

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])
    await waitFor(() => expect(pane('new')).toBeDefined())

    const textarea = pane('new').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'commit-composer' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalled())
    await waitFor(() => expect(pane('e').textContent).toContain('commit-composer'))
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4)
    expect(pane('b')).toBeDefined()
  })

  it('renders exactly one composer pane when the working set is empty', async () => {
    sessionIds.length = 0
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: [],
      focusedId: null,
      focusHistory: [],
    }))
    renderRoute('/')

    fireEvent.click(screen.getAllByRole('button', { name: 'Start empty chat' })[0])

    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1)
  })

  it('mounts only the active pane on mobile while fixed chips switch the route-backed transcript', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a', 'b'],
      focusedId: 'a',
      focusHistory: ['a', 'b'],
    }))
    renderRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1))
    expect(pane('a').textContent).toContain('transcript-a')
    const chipOrder = () => Array.from(document.querySelectorAll('[data-mobile-working-set-chip]')).map((node) => node.getAttribute('data-mobile-working-set-chip'))
    expect(chipOrder()).toEqual(sessionIds)

    fireEvent.click(await screen.findByRole('button', { name: /Title d/ }))
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1))
    await waitFor(() => expect(pane('d').textContent).toContain('transcript-d'))
    expect(chipOrder()).toEqual(sessionIds)
    expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull()
  })

  it('updates a background mobile chip in place without touching the active transcript', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    renderRoute()

    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const activeBefore = pane('a').textContent
    const chipsBefore = sessionIds.map((id) => document.querySelector(`[data-mobile-working-set-chip="${id}"]`))

    emit('session:delta', { sessionId: 'c', type: 'text', content: 'background-mobile' })

    await waitFor(() => expect(document.querySelector('[data-mobile-working-set-chip="c"] [data-mobile-working-set-preview]')?.textContent).toContain('Background-mobile'))
    expect(sessionIds.map((id) => document.querySelector(`[data-mobile-working-set-chip="${id}"]`))).toEqual(chipsBefore)
    expect(pane('a').textContent).toBe(activeBefore)
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1)
  })

  it('reacts to desktop-to-phone resize without discarding persisted members or the focused pane', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    fireEvent.click(pane('c'))
    await waitFor(() => expect(pane('c').getAttribute('data-chat-pane-active')).toBe('true'))

    act(() => {
      window.innerWidth = 1000
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1))
    expect(pane('c')).toBeDefined()
    expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(sessionIds)
  })
})
