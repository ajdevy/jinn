import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueuePanel } from '../queue-panel'

const { getSessionQueue } = vi.hoisted(() => ({
  getSessionQueue: vi.fn(async () => []),
}))

vi.mock('@/lib/api', () => ({
  api: { getSessionQueue },
}))

describe('QueuePanel session ownership', () => {
  beforeEach(() => getSessionQueue.mockClear())

  it('ignores queue updates owned by another pane', async () => {
    const { rerender } = render(<QueuePanel sessionId="a" events={[]} />)
    await waitFor(() => expect(getSessionQueue).toHaveBeenCalledTimes(1))

    rerender(<QueuePanel
      sessionId="a"
      events={[{ event: 'queue:updated', payload: { sessionId: 'b', paused: true } }]}
    />)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getSessionQueue).toHaveBeenCalledTimes(1)
  })
})
