import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { TOUCH_ORDER_STORAGE_KEY } from '../touch-order'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'

/**
 * What the phone's four slots are ranked by: the chats the OPERATOR opened.
 *
 * The route also selects chats nobody asked for — it primes the newest one so
 * the desktop thread has something to show, and falls back to a neighbour after
 * a delete. Those reach the log through the same committed selection as a real
 * open, so the route marks them and the log skips exactly those.
 */
describe('the mobile touch log', () => {
  const primedChat = 'a'

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
  })

  const touched = (): string[] => {
    const raw = localStorage.getItem(TOUCH_ORDER_STORAGE_KEY)
    return raw ? (JSON.parse(raw).sessionIds ?? []) : []
  }

  /** The route has primed the newest chat behind the list, and it is not a touch. */
  async function loadWithPrimedChat() {
    renderRoute('/')
    await waitFor(() => expect(document.querySelector(`[data-chat-pane-session="${primedChat}"]`)).not.toBeNull())
    await waitFor(() => expect(localStorage.getItem(TOUCH_ORDER_STORAGE_KEY)).not.toBeNull())
    expect(touched()).toEqual([])
  }

  const composerShown = () => waitFor(() =>
    expect(document.querySelector('[data-chat-pane-session="new"]')).not.toBeNull())

  it('stays empty when New chat swaps the list for the composer', async () => {
    await loadWithPrimedChat()

    fireEvent.click(screen.getAllByRole('button', { name: 'Start empty chat' })[0])

    await composerShown()
    expect(touched()).toEqual([])
  })

  // Contacting an employee is also where an `?employee=` deep link lands: the
  // link resolves to this same call, so it shows the list the same way.
  it('stays empty when contacting an employee swaps the list for the composer', async () => {
    await loadWithPrimedChat()

    fireEvent.click(screen.getByTestId('contact-employee'))

    await composerShown()
    expect(touched()).toEqual([])
  })

  it('records the primed chat when the operator taps its own list row', async () => {
    await loadWithPrimedChat()

    fireEvent.click(screen.getByTestId(`list-row-${primedChat}`))

    await waitFor(() => expect(touched()).toEqual([primedChat]))
  })

  it('records the primed chat when browser back returns to it from the composer', async () => {
    await loadWithPrimedChat()
    fireEvent.click(screen.getAllByRole('button', { name: 'Start empty chat' })[0])
    await composerShown()

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))

    await waitFor(() => expect(touched()).toEqual([primedChat]))
  })

  it('records a chat the operator opens from the list, and moves it back to the head on return', async () => {
    await loadWithPrimedChat()

    fireEvent.click(screen.getByTestId('list-row-b'))
    await waitFor(() => expect(touched()).toEqual(['b']))

    fireEvent.click(screen.getByTestId(`list-row-${primedChat}`))
    await waitFor(() => expect(touched()).toEqual([primedChat, 'b']))
  })
})
