import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { parseSelectedSession } from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { dispatchHostEvent } from './host-events'
import { publishHostState } from './host-state'

/**
 * Renders nothing; keeps the host's readonly state and its event fan-out fed
 * from the app's own single sources — the one gateway socket and the URL.
 * A second socket, or a second definition of "the open session", is how the
 * host's answer and the app's answer drift apart.
 */
export function PluginHostBridge() {
  const { connected, subscribe } = useGateway()
  const { search } = useLocation()

  useEffect(() => {
    publishHostState({ gatewayStatus: connected ? 'connected' : 'disconnected' })
  }, [connected])

  useEffect(() => {
    publishHostState({ activeSession: parseSelectedSession(search) })
  }, [search])

  useEffect(() => subscribe((frame) => dispatchHostEvent(frame)), [subscribe])

  return null
}
