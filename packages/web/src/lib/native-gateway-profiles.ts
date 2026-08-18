import type { JinnNativeBridge } from "@/platform/native-bridge"
import {
  GATEWAY_SOCKET_CLOSED,
  type GatewayProfile,
  type GatewaySocketConnection,
  type GatewayTransport,
} from "./gateway-transport"
import { createNativeGatewayTransport, pairNativeGateway } from "./native-gateway-transport"

const STORAGE_KEY = "jinn.native.gateway-profiles.v1"
const LEGACY_ACTIVE_ORIGIN_KEY = "jinn.native.active-origin"

export interface NativeGatewayProfile extends GatewayProfile {
  name: string
  deviceId: string
}

export type NativeGatewayStatus = "ready" | "switching" | "unreachable"

export interface NativeGatewayProfilesSnapshot {
  profiles: NativeGatewayProfile[]
  activeId?: string
  generation: number
  status: NativeGatewayStatus
  failedProfileId?: string
  error?: string
}

interface PersistedProfiles {
  version: 1
  activeId?: string
  profiles: NativeGatewayProfile[]
}

interface NativeGatewayProfilesOptions {
  bridge: JinnNativeBridge
  storage: Storage
  beforeCommit?: () => void | Promise<void>
}

export class StaleGatewayGenerationError extends DOMException {
  constructor() {
    super("The gateway changed before this response arrived", "AbortError")
  }
}

function canonicalOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid native gateway origin")
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Native gateway profiles require a bare origin")
  }
  return url.origin
}

function profileId(origin: string): string {
  return `native:${origin}`
}

function parseStoredProfiles(storage: Storage): PersistedProfiles {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw) as Partial<PersistedProfiles>
      if (value.version === 1 && Array.isArray(value.profiles)) {
        const profiles = value.profiles.filter((entry): entry is NativeGatewayProfile => (
          typeof entry?.id === "string"
          && typeof entry.origin === "string"
          && typeof entry.name === "string"
          && typeof entry.deviceId === "string"
        ))
        const activeId = profiles.some((profile) => profile.id === value.activeId) ? value.activeId : undefined
        return { version: 1, activeId, profiles }
      }
    }
    const legacyOrigin = storage.getItem(LEGACY_ACTIVE_ORIGIN_KEY)
    if (legacyOrigin) {
      const origin = canonicalOrigin(legacyOrigin)
      const profile = { id: profileId(origin), origin, name: new URL(origin).host, deviceId: "" }
      return { version: 1, activeId: profile.id, profiles: [profile] }
    }
  } catch {
    // Invalid persisted state is treated as empty; pairing can repair it.
  }
  return { version: 1, profiles: [] }
}

function stale(manager: NativeGatewayProfiles, generation: number): boolean {
  return manager.snapshot().generation !== generation
}

class GuardedSocket implements GatewaySocketConnection {
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly #listeners = new Set<(event: MessageEvent) => void>()

  constructor(
    private readonly inner: GatewaySocketConnection,
    private readonly live: () => boolean,
    private readonly release: () => void,
  ) {
    inner.onopen = (event) => { if (live()) this.onopen?.(event) }
    inner.onmessage = (event) => {
      if (!live()) return
      this.onmessage?.(event)
      for (const listener of this.#listeners) listener(event)
    }
    inner.onclose = (event) => {
      release()
      if (live()) this.onclose?.(event)
    }
    inner.onerror = (event) => { if (live()) this.onerror?.(event) }
  }

  get readyState() { return this.inner.readyState }

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#listeners.add(listener)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!this.live()) throw new StaleGatewayGenerationError()
    this.inner.send(data)
  }

  close(code?: number, reason?: string): void {
    this.release()
    this.inner.close(code, reason)
  }
}

export class NativeGatewayProfiles {
  readonly transport: GatewayTransport
  readonly #listeners = new Set<() => void>()
  readonly #sockets = new Set<GatewaySocketConnection>()
  #snapshot: NativeGatewayProfilesSnapshot

  constructor(private readonly options: NativeGatewayProfilesOptions) {
    const stored = parseStoredProfiles(options.storage)
    this.#snapshot = {
      profiles: stored.profiles,
      activeId: stored.activeId,
      generation: 0,
      status: "ready",
    }
    this.transport = this.#createTransport()
    this.#persist()
  }

  snapshot = (): NativeGatewayProfilesSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async pair(rawOrigin: string, code: string, options: { activate?: boolean } = {}): Promise<NativeGatewayProfile> {
    const origin = canonicalOrigin(rawOrigin)
    const receipt = await pairNativeGateway(origin, code, this.options.bridge)
    const transport = createNativeGatewayTransport(receipt.origin, this.options.bridge)
    const state = await this.#authState(transport)
    const name = await this.#gatewayName(transport, state.instance)
    const profile: NativeGatewayProfile = {
      id: profileId(receipt.origin),
      origin: receipt.origin,
      name,
      deviceId: receipt.device.id,
    }
    const profiles = [...this.#snapshot.profiles.filter((entry) => entry.id !== profile.id), profile]
    this.#update({ ...this.#snapshot, profiles })
    if (options.activate || !this.#snapshot.activeId) await this.#commit(profile.id)
    return profile
  }

  async select(id: string): Promise<void> {
    if (id === this.#snapshot.activeId) return
    const profile = this.#profile(id)
    this.#update({ ...this.#snapshot, status: "switching", failedProfileId: undefined, error: undefined })
    try {
      await this.#authState(createNativeGatewayTransport(profile.origin, this.options.bridge))
      // Validation is asynchronous. Removal wins if it happened while the
      // candidate gateway was answering.
      this.#profile(id)
      await this.#commit(id)
    } catch (error) {
      this.#update({
        ...this.#snapshot,
        status: "unreachable",
        failedProfileId: id,
        error: error instanceof Error ? error.message : "Gateway is unreachable",
      })
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    const profile = this.#profile(id)
    const remaining = this.#snapshot.profiles.filter((entry) => entry.id !== id)
    const wasActive = id === this.#snapshot.activeId
    if (wasActive) {
      const fallback = remaining[0]
      if (fallback) await this.select(fallback.id)
      else await this.#commit(undefined)
    }
    this.#update({ ...this.#snapshot, profiles: remaining })
    await this.options.bridge.forget({ target: { origin: profile.origin } })
  }

  async retry(): Promise<void> {
    const id = this.#snapshot.failedProfileId ?? this.#snapshot.activeId
    if (!id) return
    if (id === this.#snapshot.activeId) {
      const profile = this.#profile(id)
      await this.#authState(createNativeGatewayTransport(profile.origin, this.options.bridge))
      this.#update({ ...this.#snapshot, status: "ready", failedProfileId: undefined, error: undefined })
      return
    }
    await this.select(id)
  }

  #createTransport(): GatewayTransport {
    const manager = this
    return {
      get profile() { return manager.#activeTransport().profile },
      httpUrl(path) { return manager.#activeTransport().httpUrl(path) },
      socketUrl(path) { return manager.#activeTransport().socketUrl(path) },
      openSocket(path) {
        const generation = manager.#snapshot.generation
        const inner = manager.#activeTransport().openSocket(path)
        let socket!: GuardedSocket
        socket = new GuardedSocket(
          inner,
          () => !stale(manager, generation),
          () => manager.#sockets.delete(socket),
        )
        manager.#sockets.add(socket)
        return socket
      },
      async request(path, init) {
        const generation = manager.#snapshot.generation
        const response = await manager.#activeTransport().request(path, init)
        if (stale(manager, generation)) throw new StaleGatewayGenerationError()
        return response
      },
      navigate() {
        throw new Error("Native workspace switching must select a paired profile")
      },
    }
  }

  #activeTransport(): GatewayTransport {
    const id = this.#snapshot.activeId
    if (!id) throw new Error("No native gateway profile is active")
    return createNativeGatewayTransport(this.#profile(id).origin, this.options.bridge)
  }

  #profile(id: string): NativeGatewayProfile {
    const profile = this.#snapshot.profiles.find((entry) => entry.id === id)
    if (!profile) throw new Error(`Unknown native gateway profile: ${id}`)
    return profile
  }

  async #authState(transport: GatewayTransport): Promise<{ authenticated: boolean; instance?: string }> {
    const response = await transport.request("/api/auth/state", { method: "GET" })
    if (!response.ok) throw new Error(`Gateway access check failed (${response.status})`)
    const state = await response.json() as { authenticated?: boolean; authRequired?: boolean; instance?: string }
    if (state.authRequired && !state.authenticated) throw new Error("Gateway is not paired")
    return { authenticated: state.authenticated === true || state.authRequired === false, instance: state.instance }
  }

  async #gatewayName(transport: GatewayTransport, instance?: string): Promise<string> {
    try {
      const response = await transport.request("/api/onboarding", { method: "GET" })
      if (response.ok) {
        const onboarding = await response.json() as { portalName?: string; companyName?: string }
        const configured = onboarding.portalName?.trim() || onboarding.companyName?.trim()
        if (configured) return configured
      }
    } catch {
      // Identity enrichment is optional; the authenticated instance is enough.
    }
    return instance?.trim() || new URL(transport.profile.origin).host
  }

  async #commit(activeId: string | undefined): Promise<void> {
    await this.options.beforeCommit?.()
    this.#snapshot = {
      ...this.#snapshot,
      activeId,
      generation: this.#snapshot.generation + 1,
      status: "ready",
      failedProfileId: undefined,
      error: undefined,
    }
    for (const socket of this.#sockets) {
      if (socket.readyState !== GATEWAY_SOCKET_CLOSED) socket.close(1000, "Gateway profile changed")
    }
    this.#sockets.clear()
    this.#persist()
    this.#emit()
  }

  #update(snapshot: NativeGatewayProfilesSnapshot): void {
    this.#snapshot = snapshot
    this.#persist()
    this.#emit()
  }

  #persist(): void {
    this.options.storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      activeId: this.#snapshot.activeId,
      profiles: this.#snapshot.profiles,
    } satisfies PersistedProfiles))
    this.options.storage.removeItem(LEGACY_ACTIVE_ORIGIN_KEY)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function createNativeGatewayProfiles(options: NativeGatewayProfilesOptions): NativeGatewayProfiles {
  return new NativeGatewayProfiles(options)
}
