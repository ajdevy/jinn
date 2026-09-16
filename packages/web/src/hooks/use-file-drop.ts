import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'

type FileDropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>

function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

/** The two ways a drag ends without a drop: Escape, and leaving the window. A
 *  drag that ends off the surface never sends the balancing dragleave, so
 *  without this the overlay stays pinned over a page nobody is dragging on. */
function useAbandonedDrag(dragOver: boolean, reset: () => void): void {
  useEffect(() => {
    if (!dragOver) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragend', reset)
    }
  }, [dragOver, reset])
}

export function useFileDrop(): {
  dragOver: boolean
  droppedFiles: File[] | undefined
  clearDroppedFiles: () => void
  handlers: FileDropHandlers
} {
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const depthRef = useRef(0)
  const reset = useCallback(() => {
    depthRef.current = 0
    setDragOver(false)
  }, [])
  useAbandonedDrag(dragOver, reset)
  const consume = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])
  const onDragEnter = useCallback((event: DragEvent) => {
    if (!isFileDrag(event)) return
    consume(event)
    depthRef.current += 1
    setDragOver(true)
  }, [consume])
  const onDragLeave = useCallback((event: DragEvent) => {
    if (!isFileDrag(event) || depthRef.current === 0) return
    consume(event)
    depthRef.current -= 1
    if (depthRef.current === 0) setDragOver(false)
  }, [consume])
  const onDragOver = useCallback((event: DragEvent) => {
    if (isFileDrag(event)) consume(event)
  }, [consume])
  const onDrop = useCallback((event: DragEvent) => {
    if (!isFileDrag(event)) return
    consume(event)
    reset()
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) setDroppedFiles(files)
  }, [consume, reset])
  const clearDroppedFiles = useCallback(() => setDroppedFiles(undefined), [])
  return { dragOver, droppedFiles, clearDroppedFiles, handlers: { onDragEnter, onDragLeave, onDragOver, onDrop } }
}
