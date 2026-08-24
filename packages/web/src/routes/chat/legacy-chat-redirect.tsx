import { Navigate, useParams } from "react-router-dom"
import { sessionPath } from "@/components/chat/chat-route-helpers"

/** Preserve old and externally-authored `/chat/<id>` links without making a
 * second chat URL model. The canonical selected-chat route stays `/?session=`. */
export function legacyChatRedirectTarget(sessionId: string | undefined): string {
  return sessionId?.trim() ? sessionPath(sessionId.trim()) : "/"
}

export function LegacyChatRedirect() {
  const { sessionId } = useParams<{ sessionId?: string }>()
  return <Navigate to={legacyChatRedirectTarget(sessionId)} replace />
}
