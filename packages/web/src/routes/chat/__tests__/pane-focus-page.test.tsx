import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

describe('desktop pane focus', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
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
