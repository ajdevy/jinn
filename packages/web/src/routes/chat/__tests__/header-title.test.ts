import { describe, expect, it } from 'vitest'
import { chatHeaderTitle } from '../header-title'

const meta = (sessionId: string, title?: string, employee?: string) => ({ sessionId, title, employee })

describe('chatHeaderTitle', () => {
  it('names the composer rather than a session', () => {
    expect(chatHeaderTitle({ focusedSessionId: null, meta: null, sessions: [] })).toBe('New chat')
  })

  it('prefers live meta for the focused chat', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', 'Live title'),
      sessions: [{ id: 'a', title: 'List title' }],
    })).toBe('Live title')
  })

  it('falls back to the sessions list while that chat’s meta is still in flight', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: null,
      sessions: [{ id: 'b', title: 'Chat B' }, { id: 'a', title: 'List title' }],
    })).toBe('List title')
  })

  it('never renders another chat’s title when meta lags a switch', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'b',
      meta: meta('a', 'Chat A'),
      sessions: [{ id: 'a', title: 'Chat A' }, { id: 'b', title: 'Chat B' }],
    })).toBe('Chat B')
  })

  it('does not leak another chat’s title when the list has nothing either', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'b',
      meta: meta('a', 'Chat A'),
      sessions: [{ id: 'a', title: 'Chat A' }],
    })).toBe('')
  })

  it('names the employee when neither source has a title', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', undefined, 'a-lead'),
      sessions: [{ id: 'a', employee: 'a-lead' }],
    })).toBe('a-lead')
  })

  it('yields nothing when no source names the chat, leaving the word to the caller', () => {
    // Desktop shows nothing here and always has; the mobile nav bar, which
    // centres this string unconditionally, is the one that stands a word in.
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', '   '),
      sessions: [{ id: 'a', title: '' }],
    })).toBe('')
  })

  it('renders the arriving title once meta lands', () => {
    const sessions = [{ id: 'a', title: 'List title' }]
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: null, sessions })).toBe('List title')
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: meta('a', 'Fetched title'), sessions }))
      .toBe('Fetched title')
  })

  it('never names a chat other than the focused one', () => {
    const sessions = [{ id: 'a', title: 'Chat A' }, { id: 'b', title: 'Chat B' }]
    for (const meta of [null, { sessionId: 'a', title: 'Chat A' }]) {
      expect(chatHeaderTitle({ focusedSessionId: 'b', meta, sessions: [sessions[0]] })).toBe('')
      expect(chatHeaderTitle({ focusedSessionId: 'b', meta, sessions })).toBe('Chat B')
    }
  })
})
