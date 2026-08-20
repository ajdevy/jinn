export interface ChatWorkingSet {
  /** Stable presentation order. Focus and background activity never mutate it. */
  sessionIds: string[]
  focusedId: string | null
  /** Least to most recently focused, kept separate from presentation order. */
  focusHistory: string[]
}

interface PersistedWorkingSet {
  version: 1
  sessionIds: string[]
  focusedId: string | null
  focusHistory: string[]
}

export const WORKING_SET_STORAGE_KEY = 'jinn-chat-working-set'

type WorkingSetStorage = Pick<Storage, 'getItem' | 'setItem'>

function uniqueIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of input) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function normalize(
  sessionIds: unknown,
  focusedId: unknown,
  focusHistory: unknown,
): ChatWorkingSet {
  const ids = uniqueIds(sessionIds)
  const members = new Set(ids)
  const knownHistory = uniqueIds(focusHistory).filter((id) => members.has(id))
  const history = [
    ...ids.filter((id) => !knownHistory.includes(id)),
    ...knownHistory,
  ]

  let focus = typeof focusedId === 'string' && members.has(focusedId)
    ? focusedId
    : history.at(-1) ?? null
  if (focus) {
    const index = history.indexOf(focus)
    if (index >= 0) history.splice(index, 1)
    history.push(focus)
  } else if (ids.length === 0) {
    focus = null
  }
  return { sessionIds: ids, focusedId: focus, focusHistory: history }
}

export function createWorkingSet(
  sessionIds: string[] = [],
  focusedId: string | null = null,
): ChatWorkingSet {
  return normalize(sessionIds, focusedId, sessionIds)
}

export function focusWorkingSetSession(state: ChatWorkingSet, sessionId: string): ChatWorkingSet {
  if (!state.sessionIds.includes(sessionId)) return state
  if (state.focusedId === sessionId && state.focusHistory.at(-1) === sessionId) return state
  return normalize(state.sessionIds, sessionId, state.focusHistory)
}

export function applyWorkingSetCap(state: ChatWorkingSet, cap: number): ChatWorkingSet {
  const limit = Math.max(0, Math.floor(cap))
  if (state.sessionIds.length <= limit) return state
  if (limit === 0) return createWorkingSet()

  const remove = new Set<string>()
  for (const id of state.focusHistory) {
    if (state.sessionIds.length - remove.size <= limit) break
    if (id !== state.focusedId) remove.add(id)
  }
  return normalize(
    state.sessionIds.filter((id) => !remove.has(id)),
    state.focusedId,
    state.focusHistory.filter((id) => !remove.has(id)),
  )
}

export function addWorkingSetSession(
  state: ChatWorkingSet,
  rawSessionId: string,
  cap: number,
): ChatWorkingSet {
  const sessionId = rawSessionId.trim()
  if (!sessionId) return state
  if (state.sessionIds.includes(sessionId)) {
    return focusWorkingSetSession(state, sessionId)
  }
  return applyWorkingSetCap(normalize(
    [...state.sessionIds, sessionId],
    sessionId,
    [...state.focusHistory, sessionId],
  ), cap)
}

export function removeWorkingSetSession(
  state: ChatWorkingSet,
  sessionId: string,
): ChatWorkingSet {
  if (!state.sessionIds.includes(sessionId)) return state
  const sessionIds = state.sessionIds.filter((id) => id !== sessionId)
  const focusHistory = state.focusHistory.filter((id) => id !== sessionId)
  const focusedId = state.focusedId === sessionId
    ? focusHistory.at(-1) ?? null
    : state.focusedId
  return normalize(sessionIds, focusedId, focusHistory)
}

/** Replace the URL-owned pane without growing the working set. Ordinary
 * browser navigation uses this; explicit add actions use addWorkingSetSession. */
export function replaceFocusedWorkingSetSession(
  state: ChatWorkingSet,
  rawSessionId: string,
): ChatWorkingSet {
  const sessionId = rawSessionId.trim()
  if (!sessionId) return state
  if (state.sessionIds.includes(sessionId)) {
    return focusWorkingSetSession(state, sessionId)
  }
  if (!state.focusedId) return createWorkingSet([sessionId], sessionId)

  const focusedIndex = state.sessionIds.indexOf(state.focusedId)
  if (focusedIndex < 0) return createWorkingSet([...state.sessionIds, sessionId], sessionId)

  const sessionIds = [...state.sessionIds]
  sessionIds[focusedIndex] = sessionId
  return normalize(
    sessionIds,
    sessionId,
    [...state.focusHistory.filter((id) => id !== state.focusedId), sessionId],
  )
}

export function reorderWorkingSetSession(
  state: ChatWorkingSet,
  sessionId: string,
  toIndex: number,
): ChatWorkingSet {
  const fromIndex = state.sessionIds.indexOf(sessionId)
  if (fromIndex < 0 || !Number.isInteger(toIndex)) return state
  const boundedIndex = Math.max(0, Math.min(toIndex, state.sessionIds.length - 1))
  if (fromIndex === boundedIndex) return state
  const sessionIds = [...state.sessionIds]
  sessionIds.splice(fromIndex, 1)
  sessionIds.splice(boundedIndex, 0, sessionId)
  return { ...state, sessionIds }
}

export function serializeWorkingSet(state: ChatWorkingSet): string {
  const normalized = normalize(state.sessionIds, state.focusedId, state.focusHistory)
  const persisted: PersistedWorkingSet = { version: 1, ...normalized }
  return JSON.stringify(persisted)
}

export function restoreWorkingSet(
  raw: string | null,
  liveSessionIds: ReadonlySet<string>,
  cap: number,
): ChatWorkingSet {
  if (!raw) return createWorkingSet()
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWorkingSet>
    if (parsed.version !== 1) return createWorkingSet()
    const sessionIds = uniqueIds(parsed.sessionIds).filter((id) => liveSessionIds.has(id))
    const focusHistory = uniqueIds(parsed.focusHistory).filter((id) => liveSessionIds.has(id))
    return applyWorkingSetCap(normalize(sessionIds, parsed.focusedId, focusHistory), cap)
  } catch {
    return createWorkingSet()
  }
}

export function persistWorkingSet(storage: WorkingSetStorage, state: ChatWorkingSet): void {
  try {
    storage.setItem(WORKING_SET_STORAGE_KEY, serializeWorkingSet(state))
  } catch {
    // Private browsing and quota failures must not make chat navigation fail.
  }
}

export function loadPersistedWorkingSet(
  storage: WorkingSetStorage,
  liveSessionIds: ReadonlySet<string>,
  cap: number,
): ChatWorkingSet {
  try {
    return restoreWorkingSet(storage.getItem(WORKING_SET_STORAGE_KEY), liveSessionIds, cap)
  } catch {
    return createWorkingSet()
  }
}
