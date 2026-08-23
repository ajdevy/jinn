import type {
  OperationResult,
  PlatformAdapter,
  PlatformCapability,
  PlatformEvent,
  PlatformEventListener,
  PlatformIntent,
} from "../contracts"

export interface TestAdapter extends PlatformAdapter {
  calls: PlatformIntent[]
  emit(event: PlatformEvent): void
}

export function createTestAdapter(options: {
  results?: Partial<Record<PlatformIntent["kind"], OperationResult>>
} = {}): TestAdapter {
  const calls: PlatformIntent[] = []
  const listeners = new Map<PlatformCapability, Set<PlatformEventListener>>()

  return {
    name: "test",
    calls,
    capability: async (capability) => ({
      supported: capability in (options.results ?? {}),
      permission: "not-applicable",
      configured: true,
      available: true,
    }),
    perform: async (intent) => {
      calls.push(intent)
      return options.results?.[intent.kind] ?? { status: "unsupported" }
    },
    observe(capability, listener) {
      const group = listeners.get(capability) ?? new Set()
      group.add(listener)
      listeners.set(capability, group)
      return () => group.delete(listener)
    },
    emit(event) {
      for (const listener of listeners.get(event.kind) ?? []) listener(event)
    },
  }
}
