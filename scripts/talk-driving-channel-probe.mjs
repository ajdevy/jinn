#!/usr/bin/env node
/** Inject Talk fixture WAVs and read the Realtime data-channel witness. */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export function buildSpeakScript(wav) {
  const encoded = Buffer.from(wav).toString("base64")
  return `(async () => {
    if (!window.__talkDriving) throw new Error("Talk driving shim is not installed")
    return JSON.stringify(await window.__talkDriving.speakWav(${JSON.stringify(encoded)}))
  })()`
}

export function buildProbeScript() {
  return `JSON.stringify(window.__talkDriving?.probe() ?? { error: "Talk driving shim is not installed" })`
}

function buildClearScript() {
  return `(() => { window.__talkDriving?.clear(); return JSON.stringify({ cleared: true }) })()`
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

function runBrowser(session, source) {
  const result = spawnSync("agent-browser", ["--session", session, "eval", "--stdin"], {
    encoding: "utf8",
    input: source,
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `agent-browser exited ${result.status}`)
  return result.stdout.trim()
}

function parseArgs(argv) {
  const action = argv[2]
  const session = valueAfter(argv, "--session")
  if (!session) throw new Error("--session <agent-browser session> is required")
  if (!new Set(["speak", "probe", "clear"]).has(action)) throw new Error("action must be speak, probe, or clear")
  const wav = valueAfter(argv, "--wav")
  if (action === "speak" && !wav) throw new Error("speak requires --wav <path>")
  return { action, session, wav: wav ? path.resolve(wav) : null }
}

function main() {
  const { action, session, wav } = parseArgs(process.argv)
  if (action === "speak") {
    const bytes = fs.readFileSync(wav)
    if (bytes.toString("ascii", 0, 4) !== "RIFF") throw new Error(`${wav} is not a WAV file`)
    console.log(runBrowser(session, buildSpeakScript(bytes)))
    return
  }
  console.log(runBrowser(session, action === "probe" ? buildProbeScript() : buildClearScript()))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
