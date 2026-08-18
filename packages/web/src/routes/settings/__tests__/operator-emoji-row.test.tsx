import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The operator emoji lives in gateway config, not localStorage, so the row is
 * only honest if a rejected write takes the optimistic local pick back with it
 * and says why.
 */

const apiMocks = vi.hoisted(() => ({ completeOnboarding: vi.fn() }))
const setOperatorEmoji = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { operatorEmoji: null }, setOperatorEmoji }),
}))
vi.mock('@/components/ui/emoji-picker', () => ({
  EmojiPicker: ({ onSelect }: { onSelect: (emoji: string) => void }) => (
    <button type="button" onClick={() => onSelect('🐼')}>pick panda</button>
  ),
}))

import { OperatorEmojiRow } from '../emoji-rows'

function pickPanda() {
  render(<OperatorEmojiRow />)
  fireEvent.click(screen.getByLabelText('Choose operator emoji'))
  fireEvent.click(screen.getByText('pick panda'))
}

describe('OperatorEmojiRow', () => {
  beforeEach(() => {
    apiMocks.completeOnboarding.mockReset()
    setOperatorEmoji.mockReset()
  })

  it('rolls the pick back and names the failure when the gateway rejects it', async () => {
    apiMocks.completeOnboarding.mockRejectedValue(new Error('gateway offline'))

    pickPanda()

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('gateway offline')
    expect(setOperatorEmoji.mock.calls).toEqual([['🐼'], [null]])
  })

  it('keeps the pick and stays quiet when the gateway accepts it', async () => {
    apiMocks.completeOnboarding.mockResolvedValue({ status: 'ok', portal: {} })

    pickPanda()

    await waitFor(() => expect(apiMocks.completeOnboarding).toHaveBeenCalledWith({ operatorEmoji: '🐼' }))
    expect(setOperatorEmoji.mock.calls).toEqual([['🐼']])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
