import { readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../")
const sourceRoot = join(webRoot, "src")
const platformRoot = join(sourceRoot, "platform")

function productSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (path === platformRoot || entry.name === "__tests__") return []
      return productSources(path)
    }
    if (![".ts", ".tsx"].includes(extname(entry.name)) || entry.name.includes(".test.")) return []
    return [path]
  })
}

describe("platform product boundary", () => {
  it("keeps runtime and capability implementation reads inside platform", () => {
    const patterns = [
      /window\.Capacitor/g,
      /window\.__TAURI(?:__|_INTERNALS__)/g,
      /@capacitor\//g,
      /@tauri-apps\//g,
      /navigator\.(?:share|vibrate|clipboard|setAppBadge|clearAppBadge)/g,
      /navigator\.userAgent/g,
      /Notification\.(?:permission|requestPermission)/g,
      /new Notification\s*\(/g,
      /matchMedia\([^\n]*display-mode/g,
    ]
    const violations = productSources(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => (
        `${relative(webRoot, path)}:${source.slice(0, match.index).split("\n").length} ${match[0]}`
      )))
    })

    expect(violations).toEqual([])
  })
})
