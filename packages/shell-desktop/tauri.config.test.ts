import { describe, expect, it } from "vitest"

import { buildConfigOverlay, GATEWAY_URL_VAR, resolveServerUrl } from "./tauri.config.ts"

describe("resolveServerUrl", () => {
  it("names the variable and shows an example when it is unset", () => {
    expect(() => resolveServerUrl({})).toThrowError(
      new RegExp(`${GATEWAY_URL_VAR}.*http://192\\.0\\.2\\.10`, "s"),
    )
  })

  it("treats an empty value as unset", () => {
    expect(() => resolveServerUrl({ [GATEWAY_URL_VAR]: "   " })).toThrowError(GATEWAY_URL_VAR)
  })

  it("rejects a value that is not a URL", () => {
    expect(() => resolveServerUrl({ [GATEWAY_URL_VAR]: "192.0.2.10:7778" })).toThrowError(
      /not a URL/,
    )
  })

  // The window's origin is what the web app derives its API base from, opens its
  // socket on, and presents cookies to. A non-http(s) origin breaks all three,
  // so it fails here rather than as a blank window later.
  it("rejects a non-http(s) scheme", () => {
    expect(() => resolveServerUrl({ [GATEWAY_URL_VAR]: "file:///tmp/index.html" })).toThrowError(
      /http or https/,
    )
  })

  it("normalises a bare origin to an absolute URL", () => {
    expect(resolveServerUrl({ [GATEWAY_URL_VAR]: " http://192.0.2.10:7778 " })).toBe(
      "http://192.0.2.10:7778/",
    )
  })

  it("keeps a path, so a shell can open on a route other than the default", () => {
    expect(resolveServerUrl({ [GATEWAY_URL_VAR]: "http://192.0.2.10:7778/todos" })).toBe(
      "http://192.0.2.10:7778/todos",
    )
  })
})

describe("buildConfigOverlay", () => {
  it("puts the resolved URL on the one window the shell opens", () => {
    const overlay = buildConfigOverlay("http://192.0.2.10:7778/")
    expect(overlay.app.windows).toHaveLength(1)
    expect(overlay.app.windows[0].url).toBe("http://192.0.2.10:7778/")
  })
})
