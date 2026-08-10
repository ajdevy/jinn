import { describe, expect, it, vi } from "vitest"
import type { KVStore } from "@/lib/view-mode"
import { PluginStore, type PluginRecord } from "../plugins-store"

function fakeStore(seed?: Record<string, string>): KVStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

function record(patch: Partial<PluginRecord> = {}): PluginRecord {
  return { id: "demo", name: "Demo", kind: "client", status: "loaded", ...patch }
}

describe("plugin decisions", () => {
  it("treats absence as disabled", () => {
    expect(new PluginStore(fakeStore()).pluginActive("never-mentioned")).toBe(false)
  })

  it("honours an explicit decision in either direction", async () => {
    const store = new PluginStore(fakeStore())

    await store.setPluginEnabled("on", true)
    await store.setPluginEnabled("off", false)

    expect(store.pluginActive("on")).toBe(true)
    expect(store.pluginActive("off")).toBe(false)
  })

  it("round-trips decisions through the injected store", async () => {
    const kv = fakeStore()

    await new PluginStore(kv).setPluginEnabled("persisted", true)

    expect(new PluginStore(kv).pluginActive("persisted")).toBe(true)
  })

  it.each([
    ["unparseable", "{not json"],
    ["not an object", '"a string"'],
    ["an array", "[1,2,3]"],
  ])("degrades to no decisions when the stored value is %s", (_label, stored) => {
    const store = new PluginStore(fakeStore({ "jinn-plugin-decisions": stored }))

    expect(store.pluginActive("anything")).toBe(false)
  })

  it("drops the whole map when one value in it is not a boolean", () => {
    const store = new PluginStore(
      fakeStore({ "jinn-plugin-decisions": '{"good":true,"bad":"yes"}' }),
    )

    expect(store.pluginActive("good")).toBe(false)
    expect(store.pluginActive("bad")).toBe(false)
  })
})

describe("live toggle", () => {
  it("awaits activate() when enabling", async () => {
    const store = new PluginStore(fakeStore())
    let activated = false
    // activate() stays pending until this test releases it, so the enable can
    // only settle by waiting. A store that called activate() without awaiting
    // it would settle at the checkpoint below, while `activated` is still false.
    let release = () => {}
    const activate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            activated = true
            resolve()
          }
        }),
    )
    store.publishPlugin(record({ status: "disabled" }), { activate, deactivate: vi.fn() })

    let settled = false
    const enabling = store.setPluginEnabled("demo", true).then(() => {
      settled = true
    })
    // A macrotask boundary flushes every microtask an unawaited enable would
    // have resolved through.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)
    expect(activated).toBe(false)

    release()
    await enabling

    expect(activate).toHaveBeenCalledTimes(1)
    expect(activated).toBe(true)
  })

  it("deactivates and marks the record disabled when disabling", async () => {
    const store = new PluginStore(fakeStore())
    const deactivate = vi.fn()
    store.publishPlugin(record(), { activate: vi.fn(), deactivate })

    await store.setPluginEnabled("demo", false)

    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(store.listPlugins()[0].status).toBe("disabled")
  })

  it("persists a decision for an id with no handle without throwing", async () => {
    const kv = fakeStore()
    const store = new PluginStore(kv)

    await expect(store.setPluginEnabled("not-loaded", true)).resolves.toBeUndefined()

    expect(store.pluginActive("not-loaded")).toBe(true)
    expect(new PluginStore(kv).pluginActive("not-loaded")).toBe(true)
  })
})

describe("inventory", () => {
  it("lists, patches, and drops records", () => {
    const store = new PluginStore(fakeStore())
    store.publishPlugin(record({ id: "one" }))
    store.publishPlugin(record({ id: "two", kind: "client+server" }))

    store.patchPlugin("two", { name: "Renamed" })
    store.dropPlugin("one")

    expect(store.listPlugins()).toEqual([
      { id: "two", name: "Renamed", kind: "client+server", status: "loaded" },
    ])
  })

  it("ignores a patch for an id it has never seen", () => {
    const store = new PluginStore(fakeStore())

    store.patchPlugin("ghost", { status: "error" })

    expect(store.listPlugins()).toEqual([])
  })

  it("keeps a broken plugin listed with its reason", () => {
    const store = new PluginStore(fakeStore())
    store.publishPlugin(record({ id: "broken" }))

    store.patchPlugin("broken", { status: "error", error: "client.js is missing" })

    expect(store.listPlugins()).toEqual([
      { id: "broken", name: "Demo", kind: "client", status: "error", error: "client.js is missing" },
    ])
  })
})
