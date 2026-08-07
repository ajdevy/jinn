import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

/** One inspected thing. Only Todos exist today; carrying the kind is what lets
 *  an employee or file mention join the same stack later without a rebuild. */
export interface PeekEntry {
  kind: 'todo'
  id: string
}

export interface PeekStack {
  /** Oldest first; the last entry is what the panel shows. */
  entries: PeekEntry[]
  /** Opening a mention while the panel is already open pushes rather than
   *  replaces — following a reference must never cost you your place. The
   *  `opener` of the first entry is what gets focus back on close. */
  open: (entry: PeekEntry, opener: HTMLElement | null) => void
  /** Returns to the entry underneath. A no-op at the bottom: back never closes. */
  pop: () => void
  close: () => void
}

const PeekStackContext = createContext<PeekStack | null>(null)

export function PeekProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<PeekEntry[]>([])
  const openerRef = useRef<HTMLElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    restoreRef.current = openerRef.current
    openerRef.current = null
    setEntries([])
  }, [])

  // Focus cannot land inside an inert subtree, and the sheet inerts the app root
  // for as long as it is open. Restoring here rather than inside close() puts the
  // focus call in the commit after the panel unmounted: React runs every effect
  // cleanup before any effect body, so the panel has already lifted the inert by
  // the time this provider — its parent — runs.
  useEffect(() => {
    if (entries.length > 0) return
    const opener = restoreRef.current
    restoreRef.current = null
    // preventScroll: the mention sits mid-transcript, and the thread has to look
    // exactly as it did before the panel opened.
    if (opener?.isConnected) opener.focus({ preventScroll: true })
  }, [entries.length])

  const open = useCallback((entry: PeekEntry, opener: HTMLElement | null) => {
    if (entries.length === 0) openerRef.current = opener
    setEntries((current) => [...current, entry])
  }, [entries.length])

  const value = useMemo<PeekStack>(() => ({
    entries,
    open,
    pop: () => setEntries((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    close,
  }), [entries, open, close])

  return <PeekStackContext.Provider value={value}>{children}</PeekStackContext.Provider>
}

/** The stack, or null on a surface that never mounted a provider — a mention
 *  there stays a plain link rather than opening a panel with nowhere to go. */
export function usePeekStack(): PeekStack | null {
  return useContext(PeekStackContext)
}
