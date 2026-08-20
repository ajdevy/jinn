import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MediaAttachment, Message } from '@/lib/conversations'
import { OPERATOR_DEFAULT_EMOJI } from '@/components/ui/employee-avatar'

/* The operator's own row is the bubble and nothing beside it. The emoji picked in
 * Settings still renders on Todo activity and the sidebar; the transcript stays
 * quiet, so an avatar gutter here is a regression, not a feature. */

const settings: { operatorEmoji: string | null; employeeOverrides: Record<string, never> } = {
  operatorEmoji: '\u{1F43C}',
  employeeOverrides: {},
}

vi.mock('@/routes/settings-provider', () => ({ useSettings: () => ({ settings }) }))
vi.mock('../voice-message', () => ({ VoiceMessage: () => null }))

import { UserMessageRow } from '../user-message-row'

function message(extra: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'user', content: 'ship it', timestamp: 1755680400000, ...extra } as Message
}

describe('UserMessageRow', () => {
  it('renders no operator avatar next to the bubble', () => {
    render(<UserMessageRow msg={message()} messageId="m1" text="ship it" content="ship it" media={[]} />)

    expect(screen.getByText('ship it')).toBeTruthy()
    expect(screen.queryByText(settings.operatorEmoji!)).toBeNull()
    expect(screen.queryByText(OPERATOR_DEFAULT_EMOJI)).toBeNull()
  })

  it('gives the bubble the full row width, with no avatar gutter', () => {
    const { container } = render(
      <UserMessageRow msg={message()} messageId="m1" text="ship it" content="ship it" media={[]} />,
    )

    const row = container.firstElementChild as HTMLElement
    expect(row.className).toBe('flex flex-col items-end px-[var(--space-3)] lg:px-[var(--space-8)]')
    expect(row.querySelector('.user-msg-bubble')?.parentElement).toBe(row)
  })

  it('renders attachments with no bubble when the message is media only', () => {
    const media: MediaAttachment[] = [{ type: 'file', url: '/api/files/z', name: 'bundle.zip', size: 2048, mimeType: 'application/zip' }]
    const { container } = render(
      <UserMessageRow msg={message({ content: '' })} messageId="m1" text="" content="" media={media} />,
    )

    expect(screen.getByText('bundle.zip')).toBeTruthy()
    expect(container.querySelectorAll('.user-msg-bubble')).toHaveLength(1)
  })

  it('offers a working retry on a failed send', () => {
    const onRetry = vi.fn()
    render(
      <UserMessageRow
        msg={message({ sendState: 'failed', sendError: 'network down' })}
        messageId="m1"
        text="ship it"
        content="ship it"
        media={[]}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText('Not delivered')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledWith('ship it', undefined)
  })
})
