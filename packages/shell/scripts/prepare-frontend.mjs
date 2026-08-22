import { cp, mkdir, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const webOutput = resolve(shellRoot, "../web/out")
const destination = resolve(shellRoot, "dist/web")
const staging = resolve(shellRoot, "dist/web.next")

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await cp(webOutput, staging, { recursive: true })
await cp(resolve(shellRoot, "public/probe.html"), resolve(staging, "probe.html"))
await cp(resolve(shellRoot, "scripts/refresh-rate-probe.js"), resolve(staging, "refresh-rate-probe.js"))
await rm(destination, { recursive: true, force: true })
await rename(staging, destination)
