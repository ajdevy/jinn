import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  JinnNativeBridge,
  NativeRequestInput,
  NativeResponsePayload,
  NativeStreamEvent,
  NativeStreamInput,
} from "@/platform/native-bridge"
import {
  StaleGatewayGenerationError,
  createNativeGatewayProfiles,
} from "../native-gateway-profiles"

class MemoryStorage implements Storage {
  #values = new Map<string, string>()
  get length() { return this.#values.size }
  clear() { this.#values.clear() }
  getItem(key: string) { return this.#values.get(key) ?? null }
  key(index: number) { return [...this.#values.keys()][index] ?? null }
  removeItem(key: string) { this.#values.delete(key) }
  setItem(key: string, value: string) { this.#values.set(key, value) }
}

function response(value: unknown, status = 200): NativeResponsePayload {
  return {
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyBase64: btoa(JSON.stringify(value)),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function bridgeFixture() {
  const streams = new Map<string, (event: NativeStreamEvent) => void>()
  let streamSequence = 0
  const requests = vi.fn(async (input: NativeRequestInput) => response({
    authRequired: true,
    authenticated: true,
    canBootstrapLocal: false,
    networkExposed: false,
    instance: input.target.origin.endsWith("7779") ? "alpha" : "beta",
  }))
  const bridge: JinnNativeBridge = {
    runtime: "tauri",
    pair: vi.fn(async ({ target }) => ({
      origin: new URL(target.origin).origin,
      device: { id: `device:${new URL(target.origin).port}`, name: "Jinn shell" },
    })),
    request: requests,
    stream: vi.fn(async (input: NativeStreamInput, onEvent) => {
      if (input.action !== "open") return { streamId: input.streamId }
      const streamId = `stream-${++streamSequence}`
      streams.set(streamId, onEvent)
      onEvent({ event: "opened", streamId })
      return { streamId }
    }),
    forget: vi.fn(async () => ({ localRemoved: true, remoteRevoked: true })),
  }
  return { bridge, requests, streams }
}

describe("native gateway profiles", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("pairs a second exact-port profile without activating it", async () => {
    const { bridge } = bridgeFixture()
    const profiles = createNativeGatewayProfiles({ bridge, storage: new MemoryStorage() })

    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha-code", { activate: true })
    const generation = profiles.snapshot().generation
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta-code")

    expect(profiles.snapshot()).toMatchObject({ activeId: alpha.id, generation })
    expect(profiles.snapshot().profiles).toEqual([alpha, beta])
    expect(bridge.pair).toHaveBeenNthCalledWith(2, {
      target: { origin: "http://127.0.0.1:7780" },
      code: "beta-code",
    })
  })

  it("switches A to B to A while preserving the exact active identity", async () => {
    const { bridge } = bridgeFixture()
    const storage = new MemoryStorage()
    const beforeCommit = vi.fn(async () => {})
    const profiles = createNativeGatewayProfiles({ bridge, storage, beforeCommit })
    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha", { activate: true })
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta")

    await profiles.select(beta.id)
    expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, generation: 2 })
    expect(profiles.transport.profile.origin).toBe("http://127.0.0.1:7780")
    await profiles.select(alpha.id)
    expect(profiles.snapshot()).toMatchObject({ activeId: alpha.id, generation: 3 })
    expect(profiles.transport.profile.origin).toBe("http://127.0.0.1:7779")
    expect(beforeCommit).toHaveBeenCalledTimes(3)

    const restored = createNativeGatewayProfiles({ bridge, storage })
    expect(restored.snapshot().activeId).toBe(alpha.id)
  })

  it("quarantines a REST response and WebSocket frame delivered after a switch", async () => {
    const { bridge, requests, streams } = bridgeFixture()
    const profiles = createNativeGatewayProfiles({ bridge, storage: new MemoryStorage() })
    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha", { activate: true })
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta")
    const late = deferred<NativeResponsePayload>()
    requests.mockImplementationOnce(() => late.promise)
    const pending = profiles.transport.request("/api/sessions")
    const frames = vi.fn()
    const socket = profiles.transport.openSocket("/ws")
    socket.onmessage = frames
    await vi.waitFor(() => expect(streams.size).toBe(1))
    const alphaStream = [...streams.values()][0]!

    await profiles.select(beta.id)
    late.resolve(response({ sessions: [{ id: "alpha-only" }] }))
    alphaStream({ event: "message", streamId: "stream-1", text: JSON.stringify({ event: "sessions:changed" }) })

    await expect(pending).rejects.toBeInstanceOf(StaleGatewayGenerationError)
    expect(frames).not.toHaveBeenCalled()
    expect(profiles.snapshot().activeId).toBe(beta.id)
    expect(alpha.id).not.toBe(beta.id)
  })

  it("removes only the requested inactive profile and keeps the active profile intact", async () => {
    const { bridge } = bridgeFixture()
    const storage = new MemoryStorage()
    const profiles = createNativeGatewayProfiles({ bridge, storage })
    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha", { activate: true })
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta")

    await profiles.remove(beta.id)

    expect(profiles.snapshot()).toMatchObject({ activeId: alpha.id, profiles: [alpha] })
    expect(bridge.forget).toHaveBeenCalledWith({ target: { origin: beta.origin } })
    expect(profiles.transport.profile.origin).toBe(alpha.origin)
  })

  it("does not commit an unreachable selection and reports it distinctly", async () => {
    const { bridge, requests } = bridgeFixture()
    const profiles = createNativeGatewayProfiles({ bridge, storage: new MemoryStorage() })
    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha", { activate: true })
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta")
    requests.mockRejectedValueOnce(new TypeError("connection refused"))

    await expect(profiles.select(beta.id)).rejects.toThrow("connection refused")

    expect(profiles.snapshot()).toMatchObject({
      activeId: alpha.id,
      status: "unreachable",
      failedProfileId: beta.id,
    })
    expect(profiles.transport.profile.origin).toBe(alpha.origin)
  })

  it("cannot activate a profile removed while its selection check is in flight", async () => {
    const { bridge, requests } = bridgeFixture()
    const profiles = createNativeGatewayProfiles({ bridge, storage: new MemoryStorage() })
    const alpha = await profiles.pair("http://127.0.0.1:7779", "alpha", { activate: true })
    const beta = await profiles.pair("http://127.0.0.1:7780", "beta")
    const validation = deferred<NativeResponsePayload>()
    requests.mockImplementationOnce(() => validation.promise)

    const selecting = profiles.select(beta.id)
    await profiles.remove(beta.id)
    validation.resolve(response({ authRequired: true, authenticated: true, instance: "beta" }))

    await expect(selecting).rejects.toThrow(`Unknown native gateway profile: ${beta.id}`)
    expect(profiles.snapshot()).toMatchObject({ activeId: alpha.id, profiles: [alpha] })
  })
})
