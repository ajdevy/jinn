export const CHAT_SESSION_DND_MIME = 'application/x-jinn-chat-session'

export function hasChatSessionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_SESSION_DND_MIME)
}

export function writeChatSessionDrag(dataTransfer: DataTransfer, sessionId: string): void {
  dataTransfer.setData(CHAT_SESSION_DND_MIME, sessionId)
  dataTransfer.effectAllowed = 'copy'
}

export function readChatSessionDrop(dataTransfer: DataTransfer): string | null {
  if (!hasChatSessionDrag(dataTransfer)) return null
  const sessionId = dataTransfer.getData(CHAT_SESSION_DND_MIME).trim()
  return sessionId || null
}

export function isComposerDropTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-chat-composer]') !== null
}
