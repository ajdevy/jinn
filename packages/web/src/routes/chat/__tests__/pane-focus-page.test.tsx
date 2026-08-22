import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { apiMocks, gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

const writeText = vi.fn().mockResolvedValue(undefined)

describe('desktop pane focus', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.deleteSession.mockClear()
    apiMocks.duplicateSession.mockClear()
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
  })

  it('keeps menu actions pane-owned while shortcuts remain focus-owned', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    expect(document.querySelectorAll('[data-chat-pane-menu-trigger]')).toHaveLength(4)

    const paneC = pane('c')
    fireEvent.pointerDown(within(paneC).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(pane('a').getAttribute('data-chat-pane-active')).toBe('true')
    expect(paneC.getAttribute('data-chat-pane-active')).toBe('false')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy Session ID' }))
    expect(writeText).toHaveBeenCalledWith('c')
    expect(await within(paneC).findByTestId('chat-pane-copy-toast')).toBeTruthy()
    expect(pane('a').getAttribute('data-chat-pane-active')).toBe('true')

    fireEvent.pointerDown(within(paneC).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    const duplicateMenu = await screen.findByRole('menu')
    fireEvent.click(within(duplicateMenu).getByRole('menuitem', { name: /Duplicate/ }))
    await waitFor(() => expect(apiMocks.duplicateSession).toHaveBeenCalledWith('c'))
    expect(pane('a').getAttribute('data-chat-pane-active')).toBe('true')

    fireEvent.pointerDown(within(paneC).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session' }))
    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenNthCalledWith(1, 'c'))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="c"]')).toBeNull())

    fireEvent.keyDown(window, { key: 'Backspace' })
    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenNthCalledWith(2, 'a'))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull())
    await waitFor(() => expect(pane('b').getAttribute('data-chat-pane-active')).toBe('true'))
    await waitFor(() => expect(document.querySelectorAll('[data-chat-grid-pane][aria-current="true"]')).toHaveLength(1))
    const persisted = JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}')
    expect(persisted.sessionIds).not.toContain('a')
    expect(persisted.focusedId).toBe('b')

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
    await waitFor(() => expect(pane('b').getAttribute('data-chat-pane-active')).toBe('true'))
  })

  it('moves the single selected treatment with click and j/k navigation', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    const selected = () => document.querySelectorAll('[data-chat-grid-pane][aria-current="true"]')
    await waitFor(() => expect(selected()).toHaveLength(1))
    expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('a')

    fireEvent.click(pane('c'))
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('c'))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('d'))
    fireEvent.keyDown(window, { key: 'k' })
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('c'))
  })
})
