import { useCallback, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'

type FileDropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>

function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

export function useChatFileDrop(): {
  dragOver: boolean
  droppedFiles: File[] | undefined
  clearDroppedFiles: () => void
  handlers: FileDropHandlers
} {
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const depthRef = useRef(0)
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
    depthRef.current = 0
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) setDroppedFiles(files)
  }, [consume])
  const clearDroppedFiles = useCallback(() => setDroppedFiles(undefined), [])
  return { dragOver, droppedFiles, clearDroppedFiles, handlers: { onDragEnter, onDragLeave, onDragOver, onDrop } }
}
