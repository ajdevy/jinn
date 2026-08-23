import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { apiMocks, gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

function persistPanes(ids: string[], focusedId: string, focusHistory = ids) {
  localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
    version: 1,
    sessionIds: ids,
    focusedId,
    focusHistory,
  }))
}

describe('pane-owned former header residents', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
  })

  it('puts a drill-in back control only in its owning pane and pops that pane back', async () => {
    persistPanes(['b', 'c', 'd'], 'b', ['c', 'd', 'b'])
    renderRoute([
      { pathname: '/', search: '?session=b' },
      { pathname: '/', search: '?session=a', state: { from: { id: 'b', label: 'Parent chat' } } },
    ])

    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const paneC = pane('c')
    const paneD = pane('d')
    expect(within(pane('a')).getByRole('button', { name: 'Back to Parent chat' })).toBeTruthy()
    expect(within(paneC).queryByRole('button', { name: /Back to/ })).toBeNull()
    expect(within(paneD).queryByRole('button', { name: /Back to/ })).toBeNull()

    fireEvent.click(within(pane('a')).getByRole('button', { name: 'Back to Parent chat' }))

    await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))
    expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull()
    expect(pane('c')).toBe(paneC)
    expect(pane('d')).toBe(paneD)
  })

  it('anchors copy feedback inside the focused pane and keeps the single-pane placement', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    persistPanes(['a', 'b'], 'a', ['b', 'a'])
    const multi = renderRoute()
    await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))
    fireEvent.click(pane('b'))
    await waitFor(() => expect(pane('b').getAttribute('data-chat-pane-active')).toBe('true'))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    apiMocks.getSession.mockClear()

    fireEvent.keyDown(window, { key: 'c' })

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledWith('b'))
    const toast = await within(pane('b')).findByTestId('chat-pane-copy-toast')
    expect(toast.className).toContain('bottom-4')
    expect(toast.firstElementChild?.className).toContain('bg-[var(--material-thick)]')
    expect(toast.firstElementChild?.className).toContain('shadow-[var(--shadow-overlay)]')
    expect(within(pane('a')).queryByTestId('chat-pane-copy-toast')).toBeNull()
    expect(document.querySelector('[data-chat-page-copy-toast]')).toBeNull()
    multi.unmount()

    gateway.listeners.clear()
    persistPanes(['a'], 'a')
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    fireEvent.keyDown(window, { key: 'c' })
    const pageToast = await screen.findByTestId('chat-page-copy-toast')
    expect(pageToast.className).toContain('right-4')
    expect(pageToast.className).toContain('top-[58px]')
    expect(within(pane('a')).queryByTestId('chat-pane-copy-toast')).toBeNull()
  })
})
