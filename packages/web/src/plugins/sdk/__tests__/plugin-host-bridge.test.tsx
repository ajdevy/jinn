import { render } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'
import { host } from '../host'
import { resetHostEvents } from '../host-events'
import { resetHostState } from '../host-state'
import { PluginHostBridge } from '../plugin-host-bridge'

/**
 * The bridge is the only thing that makes `host.state` and `host.onEvent`
 * anything other than empty in the running app, so what it wires up is worth a
 * test even though the wiring itself is thin.
 */

const gateway = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  return {
    value: {
      connected: false,
      subscribe: (fn: GatewayEventListener) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    emit: (frame: GatewayEvent) => listeners.forEach((fn) => fn(frame)),
  }
})

vi.mock('@/hooks/use-gateway', () => ({ useGateway: () => gateway.value }))

function mountAt(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <PluginHostBridge /> }], {
    initialEntries: [path],
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  gateway.value.connected = false
  resetHostState()
  resetHostEvents()
})

afterEach(() => {
  vi.clearAllMocks()
})

it('publishes the gateway connection into host.state', () => {
  gateway.value.connected = true

  mountAt('/')

  expect(host.state.getSnapshot().gatewayStatus).toBe('connected')
})

it('publishes the URL-selected session into host.state', () => {
  mountAt('/?session=sess-1')

  expect(host.state.getSnapshot().activeSession).toBe('sess-1')
})

it('feeds gateway frames to host.onEvent subscribers', () => {
  const handler = vi.fn()
  host.onEvent('queue:updated', handler)
  const frame: GatewayEvent = {
    event: 'queue:updated',
    payload: { sessionId: 'sess-1', sessionKey: 'agent:main:main', depth: 0 },
  }

  mountAt('/')
  gateway.emit(frame)

  expect(handler).toHaveBeenCalledWith(frame)
})
