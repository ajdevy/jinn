import { useCallback, useState } from 'react'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatGridAddMenu } from '../chat-grid-add-menu'
import { ChatGridDropOverlay, useChatSessionDrop } from '../chat-grid-drop'
import { CHAT_SESSION_DND_MIME } from '../chat-session-dnd'
import { addWorkingSetSession, createWorkingSet, type ChatWorkingSet } from '../working-set'

function transfer(type: string, value: string): DataTransfer {
  return {
    types: [type],
    files: [] as unknown as FileList,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: vi.fn((requested: string) => requested === type ? value : ''),
  } as unknown as DataTransfer
}

function AddHarness({ mode, initial, onAction }: {
  mode: 'drop' | 'picker'
  initial: ChatWorkingSet
  onAction?: (sessionId: string) => void
}) {
  const [state, setState] = useState(initial)
  const add = useCallback((sessionId: string) => {
    onAction?.(sessionId)
    setState((current) => addWorkingSetSession(current, sessionId, 4))
  }, [onAction])
  const drop = useChatSessionDrop(add)
  return (
    <div data-testid="drop-surface" {...drop.handlers}>
      <div data-testid="transcript-a"><span data-message-id="a-1">A one</span><span data-message-id="a-2">A two</span></div>
      <div data-chat-composer data-testid="composer">Composer</div>
      {mode === 'picker' && (
        <ChatGridAddMenu
          sessions={[{ id: 'a', title: 'Title a' }, { id: 'b', title: 'Title b' }, { id: 'c', title: 'Title c' }]}
          memberIds={state.sessionIds}
          onAdd={add}
        />
      )}
      <output data-testid="working-set">{JSON.stringify(state)}</output>
      <ChatGridDropOverlay active={drop.active} />
    </div>
  )
}

async function stateAfter(mode: 'drop' | 'picker'): Promise<ChatWorkingSet> {
  const view = render(<AddHarness mode={mode} initial={createWorkingSet(['a', 'b'], 'a')} />)
  if (mode === 'drop') {
    fireEvent.drop(screen.getByTestId('drop-surface'), { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
  } else {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add chat to grid' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Title c' }))
  }
  await waitFor(() => expect(screen.getByTestId('working-set').textContent).toContain('"c"'))
  const state = JSON.parse(screen.getByTestId('working-set').textContent ?? '') as ChatWorkingSet
  view.unmount()
  return state
}

describe('chat grid add paths', () => {
  it('routes drop and picker through one add contract and produces identical state', async () => {
    const expected = {
      sessionIds: ['a', 'b', 'c'],
      focusedId: 'c',
      focusHistory: ['b', 'a', 'c'],
    }
    expect(await stateAfter('drop')).toEqual(expected)
    expect(await stateAfter('picker')).toEqual(expected)
  })

  it('focuses a duplicate drop without duplicating or reordering it', async () => {
    const action = vi.fn()
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b', 'c'], 'a')} onAction={action} />)
    fireEvent.drop(screen.getByTestId('drop-surface'), { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    await waitFor(() => expect(screen.getByTestId('working-set').textContent).toContain('"focusedId":"c"'))
    expect(JSON.parse(screen.getByTestId('working-set').textContent ?? '')).toEqual({
      sessionIds: ['a', 'b', 'c'],
      focusedId: 'c',
      focusHistory: ['b', 'a', 'c'],
    })
    expect(action).toHaveBeenCalledOnce()
  })

  it('rejects composer and foreign drops without moving or reordering transcript rows', () => {
    const action = vi.fn()
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b'], 'a')} onAction={action} />)
    const composer = screen.getByTestId('composer')
    const transcript = screen.getByTestId('transcript-a')
    const rows = [...transcript.children]
    const blockedOver = createEvent.dragOver(composer, { bubbles: true, cancelable: true })
    Object.defineProperty(blockedOver, 'dataTransfer', { value: transfer(CHAT_SESSION_DND_MIME, 'c') })
    fireEvent(composer, blockedOver)
    expect(blockedOver.defaultPrevented).toBe(false)
    fireEvent.drop(composer, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    fireEvent.drop(transcript, { dataTransfer: transfer('application/x-jinn-chat-message', 'message-a-1') })
    expect(action).not.toHaveBeenCalled()
    expect([...transcript.children]).toEqual(rows)
    expect(screen.getByTestId('working-set').textContent).toBe(JSON.stringify(createWorkingSet(['a', 'b'], 'a')))
  })

  it('shows a pointer-transparent drop zone only for an eligible transcript drop', () => {
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    fireEvent.dragEnter(surface, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    expect(screen.getByTestId('chat-grid-drop-zone').className).toContain('pointer-events-none')
    fireEvent.dragLeave(surface, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
  })
})
