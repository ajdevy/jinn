import { readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../")
const sourceRoot = join(webRoot, "src")
const transportSource = join(sourceRoot, "lib", "gateway-transport.ts")

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionSources(path)
    if (![".ts", ".tsx"].includes(extname(entry.name)) || entry.name.includes(".test.")) return []
    return [path]
  })
}

describe("gateway transport boundary", () => {
  it("keeps gateway origin, browser navigation, and direct API fetches inside the transport", () => {
    const violations = productionSources(sourceRoot).flatMap((path) => {
      if (path === transportSource) return []
      const source = readFileSync(path, "utf8")
      return [
        /(?:window\.)?location\.(?:origin|host|protocol|assign)/g,
        /fetch\(\s*["'`]\/api\//g,
        /process\.env\.NEXT_PUBLIC_GATEWAY_URL/g,
      ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => (
        `${relative(webRoot, path)}:${source.slice(0, match.index).split("\n").length} ${match[0]}`
      )))
    })

    const viteConfig = readFileSync(join(webRoot, "vite.config.ts"), "utf8")
    if (viteConfig.includes("NEXT_PUBLIC_GATEWAY_URL")) violations.push("vite.config.ts NEXT_PUBLIC_GATEWAY_URL")

    expect(violations).toEqual([])
  })
})
