import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { installVirtualLayout, type VirtualLayout } from '@/test/virtual-layout'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'

// "Open beside" makes the picker the WHOLE mobile grid, and the mobile grid has
// no pane title bar to close it from. Nothing but a navigation can release it,
// so these are the navigations that have to.

// The mobile nav bar is the second actions cluster in the DOM; the first is the
// desktop chrome, which only CSS hides and jsdom therefore still renders.
function openChatBeside() {
  const actions = screen.getAllByRole('button', { name: 'New chat' })[1].parentElement!
  fireEvent.click(within(actions).getByRole('button', { name: 'More options' }))
  fireEvent.click(within(actions).getByRole('button', { name: 'Open beside' }))
}

function tapNewChat() {
  fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[1])
}

const pickerSearch = () => screen.findByRole('combobox', { name: 'Search chats' })

describe('the mobile grid picker releases the screen', () => {
  let pickerLayout: VirtualLayout | null = null

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    apiMocks.getOrg.mockResolvedValue({
      employees: [{
        name: 'lead-developer',
        displayName: 'Lead Developer',
        department: 'platform',
        rank: 'senior',
        engine: 'claude',
        model: 'opus',
        persona: 'Builds the platform.',
      }],
    })
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1, sessionIds: ['a'], focusedId: 'a', focusHistory: ['a'],
    }))
    pickerLayout = installVirtualLayout(44, 360, {
      scroller: '[data-testid="session-picker-scroll"]',
      row: '[data-session-picker-row]',
      rowId: 'data-session-picker-row',
    })
  })

  afterEach(() => {
    pickerLayout?.release()
    pickerLayout = null
    apiMocks.getOrg.mockReset()
  })

  it('swaps the picker for the composer when new chat is tapped', async () => {
    renderRoute('/?session=a')
    await screen.findByText('transcript-a')
    openChatBeside()
    expect(await pickerSearch()).toBeTruthy()

    tapNewChat()

    expect(await screen.findByText('Who do you want to talk to?')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Search chats' })).toBeNull()
  })

  it('swaps the picker for the chat list when back is tapped', async () => {
    renderRoute('/?session=a')
    await screen.findByText('transcript-a')
    openChatBeside()
    expect(await pickerSearch()).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back to chats' }))

    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search chats' })).toBeNull())
  })

  it('swaps the picker for the transcript when another chat is opened from the list', async () => {
    renderRoute('/?session=a')
    await screen.findByText('transcript-a')
    openChatBeside()
    expect(await pickerSearch()).toBeTruthy()

    fireEvent.click(screen.getByTestId('list-row-b'))

    expect(await screen.findByText('transcript-b')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Search chats' })).toBeNull()
  })

  it('creates the session on first send from the composer it swapped in', async () => {
    renderRoute('/?session=a')
    await screen.findByText('transcript-a')
    openChatBeside()
    expect(await pickerSearch()).toBeTruthy()

    tapNewChat()
    fireEvent.click(await screen.findByRole('option', { name: /Lead Developer/ }))
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-chat-pane-session="new"] [data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'first message' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'first message', employee: 'lead-developer' }),
    ))
  })
})
