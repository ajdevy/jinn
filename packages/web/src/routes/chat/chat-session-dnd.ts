export const CHAT_SESSION_DND_MIME = 'application/x-jinn-chat-session'

let activeDragSessionId: string | null = null

export function hasChatSessionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_SESSION_DND_MIME)
}

export function writeChatSessionDrag(dataTransfer: DataTransfer, sessionId: string): void {
  activeDragSessionId = sessionId.trim() || null
  dataTransfer.setData(CHAT_SESSION_DND_MIME, sessionId)
  dataTransfer.effectAllowed = 'copy'
}

export function activeChatSessionDrag(): string | null {
  return activeDragSessionId
}

export function clearChatSessionDrag(): void {
  activeDragSessionId = null
}

export function readChatSessionDrop(dataTransfer: DataTransfer): string | null {
  if (!hasChatSessionDrag(dataTransfer)) return null
  const sessionId = dataTransfer.getData(CHAT_SESSION_DND_MIME).trim()
  return sessionId || null
}
