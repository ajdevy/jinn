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
    })).toBe('Untitled')
  })

  it('names the employee when neither source has a title', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', undefined, 'a-lead'),
      sessions: [{ id: 'a', employee: 'a-lead' }],
    })).toBe('a-lead')
  })

  it('lands on Untitled rather than a blank when no title ever arrives', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', '   '),
      sessions: [{ id: 'a', title: '' }],
    })).toBe('Untitled')
  })

  it('renders the arriving title once meta lands', () => {
    const sessions = [{ id: 'a', title: 'List title' }]
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: null, sessions })).toBe('List title')
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: meta('a', 'Fetched title'), sessions }))
      .toBe('Fetched title')
  })

  it('is never the empty string for a focused chat', () => {
    for (const sessions of [undefined, [], [{ id: 'a' }], [{ id: 'a', title: '  ' }], [{ id: 'a', title: 42 }]]) {
      expect(chatHeaderTitle({ focusedSessionId: 'a', meta: null, sessions })).not.toBe('')
    }
  })
})
