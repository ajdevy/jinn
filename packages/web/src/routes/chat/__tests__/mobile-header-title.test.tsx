import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'

interface TitleFrame { title: string; focusedId: string | null }

// One entry per commit of the header, paired with the pane the phone has on
// screen at that moment — the two things the reader sees at once.
const frames = vi.hoisted(() => [] as TitleFrame[])

vi.mock('@/components/chat/chat-tabs', () => ({
  ChatHeaderPills: ({ title, mobileWorkingSet }: { title?: string; mobileWorkingSet?: ReactNode }) => {
    // Recorded in an effect so the pane element is the one this same commit
    // painted, not the previous frame's.
    useEffect(() => {
      const pane = document.querySelector('[data-chat-pane-session]')
      frames.push({ title: title ?? '', focusedId: pane?.getAttribute('data-chat-pane-session') ?? null })
    })
    return <div><span data-testid="header-title">{title}</span>{mobileWorkingSet}</div>
  },
}))

import { __clearLiveSessionSnapshotCacheForTests } from '@/hooks/use-live-session'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'
import { WORKING_SET_STORAGE_KEY } from '../working-set'

const ALL_TITLES = ['Title a', 'Title b', 'Title c']

function seedWorkingSet(focusedId: string) {
  localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
    version: 1, sessionIds: [focusedId], focusedId, focusHistory: [focusedId],
  }))
}

beforeEach(() => {
  frames.length = 0
  sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c')
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
  localStorage.clear()
  gateway.listeners.clear()
  __clearLiveSessionSnapshotCacheForTests()
  seedWorkingSet('a')
})

/** No frame is the blank the mobile nav bar used to centre, and no frame names
 *  a chat other than the one it has on screen. A chat still being named reads
 *  "Untitled", which belongs to no chat and so cannot be mistaken for one. */
function noFrameMisnamesTheChatOnScreen() {
  expect(frames.length).toBeGreaterThan(0)
  for (const { title, focusedId } of frames) {
    expect(title).not.toBe('')
    const otherChats = ALL_TITLES.filter((candidate) => candidate !== `Title ${focusedId}`)
    expect(otherChats, `showed "${title}" over chat ${focusedId}`).not.toContain(title)
  }
}

describe('mobile chat header title', () => {
  it('names the chat on screen through a repeated switch', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('header-title').textContent).toBe('Title a'))

    for (const id of ['b', 'a', 'c']) {
      frames.length = 0
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Title ${id}`) }))
      await waitFor(() => expect(screen.getByTestId('header-title').textContent).toBe(`Title ${id}`))
      noFrameMisnamesTheChatOnScreen()
      expect(frames.at(-1)).toMatchObject({ title: `Title ${id}`, focusedId: id })
    }
  })

  it('names a chat whose own meta never arrives rather than rendering a blank', async () => {
    seedWorkingSet('b')
    apiMocks.getSession.mockImplementation(() => new Promise(() => {}))
    try {
      renderRoute('/?session=b')
      await waitFor(() => expect(screen.getByTestId('header-title').textContent).toBe('Title b'))
      noFrameMisnamesTheChatOnScreen()
    } finally {
      apiMocks.getSession.mockReset()
    }
  })
})
