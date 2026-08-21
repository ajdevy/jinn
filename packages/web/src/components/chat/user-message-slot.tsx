import { useContext } from 'react'
import { type MediaAttachment, type Message } from '@/lib/conversations'
import { QueuedMessageCard } from './queued-message-card'
import { SessionQueueContext } from './use-session-queue'
import { UserMessageRow } from './user-message-row'

/* Which of the two shapes an operator message takes. A message still parked in
 * the queue renders as the card that can edit, drop or promote it; once it has
 * been claimed by a turn there is nothing left to act on and it settles into the
 * ordinary bubble. */

interface UserMessageSlotProps {
  msg: Message
  messageId: string
  text: string
  content: React.ReactNode
  media: MediaAttachment[]
  entering?: boolean
  onRetry?: (text: string, media?: MediaAttachment[]) => void
}

export function UserMessageSlot(props: UserMessageSlotProps) {
  const queued = useContext(SessionQueueContext).byMessageId.get(props.messageId)
  // A queued message with attachments still needs the bubble's media row, so the
  // card only takes over the plain-text case it can render honestly.
  if (!queued || props.media.length > 0 || !props.text) return <UserMessageRow {...props} />
  return <QueuedMessageCard queued={queued} text={props.text} />
}
