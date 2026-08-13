import { createContext, useCallback, useContext, useRef, useState } from 'react'

/**
 * Expansion state that outlives the row it belongs to.
 *
 * A virtualised transcript unmounts rows the reader scrolls past, and a
 * `useState` inside one dies with it — an expanded tool group or a "Show more"
 * user bubble would silently re-close every time it left the window. The value
 * lives in a Map on the transcript instead, keyed by message id, and each row
 * re-reads it on mount.
 *
 * Deliberately not React state: nothing outside the toggling row needs to
 * re-render, and a store in the parent would re-render the whole window.
 */
export type TranscriptExpansionStore = Map<string, boolean>

const TranscriptExpansionContext = createContext<TranscriptExpansionStore | null>(null)

export const TranscriptExpansionProvider = TranscriptExpansionContext.Provider

/** One store per transcript, so switching sessions starts clean. */
export function useTranscriptExpansionStore(): TranscriptExpansionStore {
  const store = useRef<TranscriptExpansionStore | null>(null)
  if (store.current === null) store.current = new Map()
  return store.current
}

/** Like `useState(initial)`, but the value survives the row unmounting. */
export function usePersistentExpansion(
  key: string,
  initial: boolean,
): [boolean, (next: boolean) => void] {
  const store = useContext(TranscriptExpansionContext)
  const [value, setValue] = useState(() => store?.get(key) ?? initial)
  const set = useCallback((next: boolean) => {
    store?.set(key, next)
    setValue(next)
  }, [store, key])
  return [value, set]
}
