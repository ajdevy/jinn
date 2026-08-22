import type { ChatWorkingSet } from './working-set'

export interface GridDropTargetContext {
  workingSet: ChatWorkingSet
  paneKeys: readonly string[]
  primaryPaneKey: string
  committedSessionId: string | null
  pickerPaneKey?: string | null
}

function sessionForPaneKey(paneKey: string, context: GridDropTargetContext): string | null {
  if (paneKey === context.pickerPaneKey) return null
  if (paneKey !== context.primaryPaneKey) {
    return context.workingSet.sessionIds.includes(paneKey) ? paneKey : null
  }
  if (!context.committedSessionId) return null
  if (context.workingSet.sessionIds.includes(context.committedSessionId)) {
    return context.committedSessionId
  }
  return context.workingSet.focusedId
}

/** Maps a mounted DOM-grid slot back into the complete (possibly folded) working set. */
export function workingSetIndexForGridSlot(
  domSlot: number,
  context: GridDropTargetContext,
): number {
  const slot = Number.isFinite(domSlot)
    ? Math.max(0, Math.min(Math.floor(domSlot), context.paneKeys.length))
    : context.paneKeys.length

  for (let index = slot; index < context.paneKeys.length; index += 1) {
    const sessionId = sessionForPaneKey(context.paneKeys[index], context)
    if (!sessionId) continue
    const workingSetIndex = context.workingSet.sessionIds.indexOf(sessionId)
    if (workingSetIndex >= 0) return workingSetIndex
  }
  return context.workingSet.sessionIds.length
}
