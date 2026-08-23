import { Suspense, lazy } from "react"
import { useSettings } from "@/routes/settings-provider"
import { useTalkSessionId } from "./talk-session-store"

/** Lazy, because the initial critical path has a budget and the surface is off
 *  for everyone who has not asked for it. The transport and the tool registry
 *  hang off this import, so nothing about voice is parsed until it is. */
const TalkLiveSurface = lazy(() =>
  import("./talk-live-surface").then((module) => ({ default: module.TalkLiveSurface })),
)

/**
 * Mounted once above the router so the orb survives every route change. Renders
 * nothing — and fetches nothing — until the Talk Orb setting is on, and opens
 * nothing until the orb itself is activated: the call that opens a session
 * mints a paid provider credential, so a mount must never be what makes it.
 */
export function TalkOrbOverlay() {
  const { settings } = useSettings()
  // Null until the transport below opens one. It is read here rather than
  // there so the store stays the single answer to "which session is open".
  const sessionId = useTalkSessionId()
  if (!settings.talkOrb) return null
  return (
    <Suspense fallback={null}>
      <TalkLiveSurface sessionId={sessionId} variant={settings.talkOrbVariant} intensity={settings.talkOrbIntensity} />
    </Suspense>
  )
}
