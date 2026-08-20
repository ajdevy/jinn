import { type MediaAttachment, type Message } from '@/lib/conversations'
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from '@/components/ui/employee-avatar'
import { CollapsibleUserText } from './collapsible-user-text'
import { MessageMedia } from './message-media'
import { SendFailureRow } from './send-failure-row'

/* The operator's own side of the transcript: their bubble, its attachments, the
 * row a failed send leaves behind, and the icon they picked in Settings. */

interface UserMessageRowProps {
  msg: Message
  messageId: string
  /** Empty when the message is attachments only, which renders no bubble. */
  text: string
  content: React.ReactNode
  media: MediaAttachment[]
  entering?: boolean
  onRetry?: (text: string, media?: MediaAttachment[]) => void
}

export function UserMessageRow({ msg, messageId, text, content, media, entering, onRetry }: UserMessageRowProps) {
  return (
    <div className="flex items-end justify-end gap-[var(--space-2)] px-[var(--space-3)] lg:px-[var(--space-8)]">
      <div className="flex min-w-0 flex-col items-end">
        {text && (
          <div data-send-state={msg.sendState} data-msg-enter={entering || undefined} className="user-msg-bubble py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-sm)_var(--radius-lg)] bg-[var(--accent-fill)] text-[var(--text-primary)] text-[length:var(--text-body)] font-[var(--weight-medium)] shadow-[var(--shadow-subtle)]">
            <CollapsibleUserText messageId={messageId}>{content}</CollapsibleUserText>
          </div>
        )}
        {media.length > 0 && (
          <div data-send-state={msg.sendState} className="user-msg-bubble">
            <MessageMedia media={media} isUser={true} />
          </div>
        )}
        {msg.sendState === 'failed' && (
          // Resend what was SENT, not the url-stripped display text — the send path supersedes the failed row by content, and an attachment-only failure retries on its media.
          <SendFailureRow reason={msg.sendError} onRetry={onRetry && (msg.content || media.length > 0) ? () => onRetry(msg.content, msg.media) : undefined} />
        )}
      </div>
      {/* "operator" is the reserved actor kind on the wire, so this resolves
          from the operator's own setting, not the employee overrides. */}
      <EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={22} fontSize={12} className="bg-[var(--fill-secondary)]" />
    </div>
  )
}
