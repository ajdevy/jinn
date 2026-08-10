import {
  hostNavigator,
  hostNotificationSink,
  type HostNotifyLevel,
} from './host-bridge'
import { onHostEvent, type HostEventHandler } from './host-events'
import { getHostState, subscribeHostState, type HostState } from './host-state'

/** Every failure the SDK raises, named so a plugin author can tell an SDK
 *  problem from one of their own. */
export class PluginSdkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginSdkError'
  }
}

/**
 * The host API, in the three tiers the plugin spec describes: readonly state,
 * then curated actions. The typed verbs (`todos`, `sessions`, `employees`) are
 * a later slice and are deliberately absent rather than stubbed.
 */
export interface PluginHost {
  readonly state: {
    getSnapshot(): HostState
    subscribe(listener: (state: HostState) => void): () => void
  }
  onEvent(type: string, handler: HostEventHandler): () => void
  navigate(path: string): void
  notify(message: string, level?: HostNotifyLevel): void
}

function navigate(path: string): void {
  const navigateTo = hostNavigator()
  if (!navigateTo) {
    throw new PluginSdkError(
      `[plugin-sdk] host.navigate(${JSON.stringify(path)}) has nowhere to go: the app registers its ` +
        'navigator as it mounts, and it has not mounted yet. Navigate from an effect or an event handler, not ' +
        'from module scope.',
    )
  }
  navigateTo(path)
}

function notify(message: string, level: HostNotifyLevel = 'info'): void {
  const sink = hostNotificationSink()
  if (!sink) {
    // Not silent, and not fatal either: a dropped notification is worth a line
    // in the console, but it is never worth taking a plugin down over.
    console.warn(`[plugin-sdk] no notification surface is mounted; dropping ${level}: ${message}`)
    return
  }
  try {
    sink(message, level)
  } catch (error) {
    // A notification surface that throws is the host's bug, and the plugin that
    // asked for the notification is the wrong place for it to land.
    console.error(`[plugin-sdk] the notification surface threw on ${level}: ${message}`, error)
  }
}

export const host: PluginHost = {
  state: {
    getSnapshot: getHostState,
    subscribe: subscribeHostState,
  },
  onEvent: onHostEvent,
  navigate,
  notify,
}
