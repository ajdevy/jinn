import { useRef } from "react"
import type { MouseEvent, PointerEvent } from "react"

/**
 * Dismiss handlers for an overlay whose own element is the backdrop.
 *
 * Closing on pointerdown unmounts the overlay before the pointer is released, so the browser
 * delivers the resulting click to whatever now sits under the cursor and activates it — for the
 * image lightbox, the thumbnail behind the backdrop. These dismiss on the completed click, and
 * only when the press started on the backdrop as well: a click that merely ended there is the
 * end of a drag that began on the content.
 */
export function useBackdropDismiss(onDismiss: () => void) {
  const pressedBackdrop = useRef(false)

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      pressedBackdrop.current = event.target === event.currentTarget
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const startedOnBackdrop = pressedBackdrop.current
      pressedBackdrop.current = false
      if (startedOnBackdrop && event.target === event.currentTarget) onDismiss()
    },
  }
}
