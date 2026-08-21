import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem } from '@/lib/api'
import { QueuedMessageCard } from '@/components/chat/queued-message-card'
import { UserMessageSlot } from '@/components/chat/user-message-slot'
import { SessionQueueContext, indexByMessage, type SessionQueue } from '@/components/chat/use-session-queue'
import type { Message } from '@/lib/conversations'

/* ICI-1365 — a queued message is a card in message position, carrying exactly
 * the three actions the operator asked for: edit it, drop it, or send it now. */

const verbs = { cancel: vi.fn(), edit: vi.fn(), sendNow: vi.fn() }

beforeEach(() => {
  verbs.cancel.mockReset().mockResolvedValue(undefined)
  verbs.edit.mockReset().mockResolvedValue(undefined)
  verbs.sendNow.mockReset().mockResolvedValue(undefined)
})

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'qi_1',
    sessionId: 's1',
    prompt: 'draft the digest',
    status: 'pending',
    position: 1,
    createdAt: '2026-08-21T10:00:00.000Z',
    messageId: 'm1',
    ...overrides,
  }
}

function renderCard(position: number, text = 'draft the digest') {
  const queue: SessionQueue = { byMessageId: new Map(), ...verbs }
  return render(
    <SessionQueueContext.Provider value={queue}>
      <QueuedMessageCard queued={{ item: queueItem(), position }} text={text} />
    </SessionQueueContext.Provider>,
  )
}

describe('the queued message card', () => {
  it('offers exactly three actions and no fourth', () => {
    renderCard(1)

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Edit this message',
      'Cancel this message',
      'Send this message now',
    ])
  })

  it('cancels through the queue, and promotes through it', async () => {
    renderCard(1)

    await userEvent.click(screen.getByLabelText('Cancel this message'))
    expect(verbs.cancel).toHaveBeenCalledWith('qi_1')

    await userEvent.click(screen.getByLabelText('Send this message now'))
    expect(verbs.sendNow).toHaveBeenCalledWith('qi_1')
  })

  it('edits in place, saving on Return', async () => {
    renderCard(1)

    await userEvent.click(screen.getByLabelText('Edit this message'))
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(field.value).toBe('draft the digest')

    await userEvent.type(field, ' and post it{Enter}')

    expect(verbs.edit).toHaveBeenCalledWith('qi_1', 'draft the digest and post it')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('reverts on Escape without asking the server for anything', async () => {
    renderCard(1)

    await userEvent.click(screen.getByLabelText('Edit this message'))
    await userEvent.type(screen.getByRole('textbox'), ' scrapped{Escape}')

    expect(verbs.edit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('draft the digest')).toBeTruthy()
  })

  it('says where in the queue it sits, and that it is being edited', async () => {
    const { unmount } = renderCard(1)
    expect(screen.getByText('Sends after this reply')).toBeTruthy()
    unmount()

    renderCard(3)
    expect(screen.getByText('3rd in queue')).toBeTruthy()

    await userEvent.click(screen.getByLabelText('Edit this message'))
    expect(screen.getByText('Editing · Return to save')).toBeTruthy()
  })
})

describe('indexByMessage', () => {
  // A pending row with no bubble is still work that runs first, so it holds its
  // place in the count even though it renders no card. The caption answers "when
  // does mine run", and skipping it would answer that wrongly.
  it('numbers every parked row from one, and renders only the ones with a bubble', () => {
    const index = indexByMessage([
      queueItem({ id: 'qi_running', messageId: 'm0', status: 'running' }),
      queueItem({ id: 'qi_1', messageId: 'm1' }),
      queueItem({ id: 'qi_internal', messageId: null }),
      queueItem({ id: 'qi_2', messageId: 'm2' }),
    ])

    expect([...index].map(([id, entry]) => [id, entry.item.id, entry.position]))
      .toEqual([['m1', 'qi_1', 1], ['m2', 'qi_2', 3]])
  })
})

describe('an operator message in the transcript', () => {
  const message = { id: 'm1', role: 'user', content: 'draft the digest' } as unknown as Message

  function renderSlot(byMessageId: ReadonlyMap<string, { item: QueueItem; position: number }>) {
    return render(
      <SessionQueueContext.Provider value={{ byMessageId, ...verbs }}>
        <UserMessageSlot
          msg={message}
          messageId="m1"
          text="draft the digest"
          content="draft the digest"
          media={[]}
        />
      </SessionQueueContext.Provider>,
    )
  }

  it('renders as the queued card while it is still parked', () => {
    renderSlot(indexByMessage([queueItem()]))

    expect(screen.getByText('Sends after this reply')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('settles back into the ordinary bubble once the queue has let it through', () => {
    renderSlot(indexByMessage([queueItem({ status: 'running' })]))

    expect(screen.queryByText('Sends after this reply')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('draft the digest')).toBeTruthy()
  })
})
