export function adjacentSessionId(
  sessionIds: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | undefined {
  if (sessionIds.length === 0) return undefined
  const currentIndex = currentId ? sessionIds.indexOf(currentId) : -1
  if (currentIndex < 0) return direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1]
  return sessionIds[(currentIndex + direction + sessionIds.length) % sessionIds.length]
}
