import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const here = import.meta.dirname
const packageJson = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as {
  name: string
  scripts: Record<string, string>
}
const tauriConfig = JSON.parse(readFileSync(resolve(here, "src-tauri/tauri.conf.json"), "utf8")) as {
  build: { frontendDist: string }
  app: { windows: Array<{ label: string; url?: string }>; security: { csp: string | null } }
}
const mainCapability = JSON.parse(
  readFileSync(resolve(here, "src-tauri/capabilities/main.json"), "utf8"),
) as { windows: string[]; permissions: string[]; remote?: unknown }
const probeCapability = JSON.parse(
  readFileSync(resolve(here, "src-tauri/capabilities/probe.json"), "utf8"),
) as { windows: string[]; permissions: string[]; remote?: unknown }

describe("bundled Tauri shell", () => {
  it("is the one cross-platform shell package and builds the web bundle first", () => {
    expect(packageJson.name).toBe("@jinn/shell")
    expect(packageJson.scripts["desktop:build"]).toMatch(/^pnpm --filter @jinn\/web build .*cargo tauri build/)
    expect(packageJson.scripts["desktop:build"]).not.toContain("JINN_SHELL_SERVER_URL")
    expect(packageJson.scripts.test).toContain("cargo test")
  })

  it("loads local web assets in one main window under a strict CSP", () => {
    expect(tauriConfig.build.frontendDist).toBe("../dist/web")
    expect(tauriConfig.app.windows).toEqual([])
    const main = readFileSync(resolve(here, "src-tauri/src/main.rs"), "utf8")
    expect(main).toContain('WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))')
    expect(main).toContain(".on_navigation(")
    expect(main).toContain(".on_new_window(")
    expect(tauriConfig.app.security.csp).toEqual(expect.any(String))
    expect(tauriConfig.app.security.csp).toContain("default-src 'self'")
    expect(tauriConfig.app.security.csp).toContain("connect-src ipc: http://ipc.localhost")
    expect(tauriConfig.app.security.csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/)
  })

  it("keeps main and probe capabilities local, separate, and narrow", () => {
    expect(mainCapability.windows).toEqual(["main"])
    expect(mainCapability.remote).toBeUndefined()
    expect(mainCapability.permissions).toEqual(["core:default"])
    expect(probeCapability.windows).toEqual(["probe"])
    expect(probeCapability.remote).toBeUndefined()
    expect(probeCapability.permissions).toEqual(["core:default"])
  })

  it("contains no generated remote-window configuration path", () => {
    const sources = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/src/main.rs"]
      .map((path) => readFileSync(resolve(here, path), "utf8"))
      .join("\n")
    expect(sources).not.toContain("JINN_SHELL_SERVER_URL")
    expect(sources).not.toContain("tauri.conf.gen.json")
  })
})
