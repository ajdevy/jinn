import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@/lib/conversations'
import { OPERATOR_DEFAULT_EMOJI } from '@/components/ui/employee-avatar'

/* The operator's own messages carry the icon they picked in Settings, the same
 * one their Todo comments use. Employee rows resolve elsewhere and are untouched. */

const settings: { operatorEmoji: string | null; employeeOverrides: Record<string, never> } = {
  operatorEmoji: null,
  employeeOverrides: {},
}

vi.mock('@/routes/settings-provider', () => ({ useSettings: () => ({ settings }) }))

import { UserMessageRow } from '../user-message-row'

function renderRow(operatorEmoji: string | null) {
  settings.operatorEmoji = operatorEmoji
  const msg = { id: 'm1', role: 'user', content: 'ship it', timestamp: 1755680400000 } as Message
  render(<UserMessageRow msg={msg} messageId="m1" text="ship it" content="ship it" media={[]} />)
}

describe('UserMessageRow', () => {
  it('renders the emoji the operator chose', () => {
    renderRow('\u{1F43C}')
    expect(screen.getByText('\u{1F43C}')).toBeTruthy()
  })

  it('falls back to the operator default when nothing is chosen', () => {
    renderRow(null)
    expect(screen.getByText(OPERATOR_DEFAULT_EMOJI)).toBeTruthy()
  })
})
