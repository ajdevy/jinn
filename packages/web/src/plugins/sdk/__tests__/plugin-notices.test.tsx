import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'
import { host } from '../host'
import { clearHostBridge } from '../host-bridge'
import { resetHostEvents } from '../host-events'
import { resetHostState } from '../host-state'
import { PluginHostBridge } from '../plugin-host-bridge'
import { PluginNotices } from '../plugin-notices'

/**
 * The surface is what makes the sink non-null in the running app. Without it
 * mounted, both halves of `host.notify` take their "nothing is listening"
 * branch and the operator sees a console line instead of the notice.
 */

const gateway = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  return {
    value: {
      connected: true,
      subscribe: (fn: GatewayEventListener) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    emit: (frame: GatewayEvent) => listeners.forEach((fn) => fn(frame)),
  }
})

vi.mock('@/hooks/use-gateway', () => ({ useGateway: () => gateway.value }))

/** Both halves of the host, in the order `client-providers.tsx` mounts them. */
function mountDashboard() {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <PluginNotices />
            <PluginHostBridge />
          </>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  resetHostState()
  resetHostEvents()
  clearHostBridge()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('registers itself as the sink, so a browser notice reaches the screen', () => {
  mountDashboard()

  act(() => host.notify('the mailbox is unreachable', 'error'))

  expect(screen.getByText('the mailbox is unreachable')).not.toBeNull()
})

/* Acceptance criterion 8's browser half, end to end: a backend notice travels
 * as a gateway frame and comes out on the same surface the browser verb uses. */
it('shows a backend notice that arrived as a gateway frame', () => {
  mountDashboard()

  act(() =>
    gateway.emit({
      event: 'plugin:notice',
      payload: { pluginId: 'mailbox', message: '3 new messages', level: 'warning' },
    }),
  )

  expect(screen.getByText('3 new messages')).not.toBeNull()
})

it('takes a notice away when it is dismissed', async () => {
  const user = userEvent.setup()
  mountDashboard()
  act(() => host.notify('read me'))

  await user.click(screen.getByRole('button', { name: 'Dismiss' }))

  expect(screen.queryByText('read me')).toBeNull()
})

/* A notice nobody dismissed must not still be on screen an hour later — an
 * unattended dashboard is the normal case, not the exception. */
it('clears a notice once its reading time is up', () => {
  vi.useFakeTimers()
  mountDashboard()
  act(() => host.notify('transient'))

  act(() => void vi.advanceTimersByTime(6_000))

  expect(screen.queryByText('transient')).toBeNull()
})

/* A watcher in a retry loop can call notify without limit. The stack is capped
 * so the newest is always readable and the app is never papered over. */
it('keeps only the newest few when a plugin floods it', () => {
  mountDashboard()

  act(() => {
    for (const message of ['first', 'second', 'third', 'fourth']) host.notify(message)
  })

  expect(screen.queryByText('first')).toBeNull()
  expect(screen.getByText('fourth')).not.toBeNull()
})
