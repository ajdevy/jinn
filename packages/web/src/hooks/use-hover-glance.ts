import { useEffect, useState } from "react"

/* Below this width the pointer is a finger: there is no hover to preview with,
 * and the tap belongs to navigation. The glance is not rendered at all rather
 * than rendered-and-hidden, so a tap can never land on it. */
const NO_HOVER_QUERY = "(max-width: 640px)"

function prefersHoverGlance(): boolean {
  if (typeof window === "undefined") return false
  return !window.matchMedia?.(NO_HOVER_QUERY).matches
}

/** Whether this viewport gets the hover glance on Todo mentions. */
export function useHoverGlanceEnabled(): boolean {
  const [enabled, setEnabled] = useState(prefersHoverGlance)

  useEffect(() => {
    const media = window.matchMedia?.(NO_HOVER_QUERY)
    if (!media) return
    const update = () => setEnabled(!media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return enabled
}
