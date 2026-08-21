import { useCallback, useState } from 'react'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatGridAddMenu } from '../chat-grid-add-menu'
import { ChatGridDropOverlay, useChatSessionDrop } from '../chat-grid-drop'
import { CHAT_SESSION_DND_MIME } from '../chat-session-dnd'
import { placementForPointer } from '../grid-placement'
import { addWorkingSetSession, createWorkingSet, insertWorkingSetSession, type ChatWorkingSet } from '../working-set'

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

function fireDragAt(
  target: HTMLElement,
  kind: 'dragOver' | 'drop',
  point: { x: number; y: number },
  dataTransfer: DataTransfer,
): void {
  const event = createEvent[kind](target, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: point.x },
    clientY: { value: point.y },
    dataTransfer: { value: dataTransfer },
  })
  fireEvent(target, event)
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
  const insert = useCallback((sessionId: string, index: number) => {
    onAction?.(sessionId)
    setState((current) => insertWorkingSetSession(current, sessionId, index, 4))
  }, [onAction])
  const drop = useChatSessionDrop(insert)
  return (
    <div data-testid="drop-surface" {...drop.handlers}>
      <div data-testid="chat-grid">
        {state.sessionIds.map((id) => (
          <div key={id} data-chat-grid-pane={id} data-testid={`transcript-${id}`}>
            {id === 'a' && <><span data-message-id="a-1">A one</span><span data-message-id="a-2">A two</span></>}
          </div>
        ))}
      </div>
      <div data-chat-composer data-testid="composer">Composer</div>
      {mode === 'picker' && (
        <ChatGridAddMenu
          sessions={[{ id: 'a', title: 'Title a' }, { id: 'b', title: 'Title b' }, { id: 'c', title: 'Title c' }]}
          memberIds={state.sessionIds}
          onAdd={add}
        />
      )}
      <output data-testid="working-set">{JSON.stringify(state)}</output>
      <ChatGridDropOverlay placement={drop.placement} />
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 200, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    fireDragAt(surface, 'dragOver', { x: 10, y: 50 }, transfer(CHAT_SESSION_DND_MIME, 'c'))
    expect(screen.getByTestId('chat-grid-drop-zone').className).toContain('pointer-events-none')
    fireEvent.dragLeave(surface, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
  })

  it('renders the placement model index and region for every pane slice', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 250, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const paneRects = [new DOMRect(0, 0, 100, 100), new DOMRect(100, 0, 100, 100)]
    const gridRect = new DOMRect(0, 0, 250, 100)
    const points = [
      { x: 10, y: 50 },
      { x: 90, y: 50 },
      { x: 50, y: 10 },
      { x: 50, y: 90 },
      { x: 225, y: 50 },
    ]

    for (const point of points) {
      fireDragAt(surface, 'dragOver', point, transfer(CHAT_SESSION_DND_MIME, 'c'))
      const expected = placementForPointer(point, paneRects, gridRect)!
      const preview = screen.getByTestId('chat-grid-drop-zone')
      expect(preview.dataset.dropRegion).toBe(expected.region)
      expect(preview.dataset.dropIndex).toBe(String(expected.targetIndex))
    }
  })

  it('drops at the exact insertion index shown by the live preview', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 200, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness mode="drop" initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'c')
    fireDragAt(surface, 'dragOver', { x: 110, y: 50 }, dataTransfer)
    expect(screen.getByTestId('chat-grid-drop-zone').dataset.dropIndex).toBe('1')

    fireDragAt(surface, 'drop', { x: 110, y: 50 }, dataTransfer)

    await waitFor(() => expect(JSON.parse(screen.getByTestId('working-set').textContent ?? '').sessionIds).toEqual(['a', 'c', 'b']))
  })
})
