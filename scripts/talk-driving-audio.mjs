#!/usr/bin/env node
/**
 * Generate the spoken turns used by the disposable Talk driving journey.
 *
 * The account key comes only from OPENAI_API_KEY. Generated WAVs belong in a
 * throwaway evidence directory and are never committed.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SAMPLE_RATE = 24_000
const TTS_URL = "https://api.openai.com/v1/audio/speech"

export const TALK_DRIVING_UTTERANCES = [
  { id: "grounded-read", text: "What are we looking at?" },
  {
    id: "send-message",
    text: "Send them a message: ping, are you still on this?",
    synthesis: "Send them a message saying ping are you still on this",
  },
  { id: "create-todo", text: "Make me a Todo: check the sandbox replay." },
  { id: "assign-todo", text: "Assign it to Sandbox Builder." },
  { id: "move-todo", text: "Move it to executing." },
  {
    id: "read-missing-todo",
    text: "Read Todo ZZZ-999.",
    synthesis: "Read the Todo whose ID is uppercase Z, uppercase Z, uppercase Z, followed by dash nine nine nine.",
  },
  {
    id: "transport-retry",
    text: "Make a fresh authoritative read through the gateway for Todo ZZZ-999. Do not reuse the prior result.",
    synthesis: "Make a fresh authoritative read through the gateway for the Todo whose ID is uppercase Z, uppercase Z, uppercase Z, followed by dash nine nine nine. Do not reuse the prior result.",
  },
]

/** Wrap raw PCM16 mono in the WAV container Chromium decodes reliably. */
export function encodePcmWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function synthesize(apiKey, text, fetchImpl) {
  const response = await fetchImpl(TTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      instructions: "Speak clearly at a natural pace. Read punctuation and identifiers precisely.",
      response_format: "pcm",
    }),
  })
  if (!response.ok) {
    throw new Error(`OpenAI could not synthesize Talk fixture audio (${response.status}): ${(await response.text()).slice(0, 400)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function generateTalkDrivingAudio(outDir, apiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to generate Talk fixture audio")
  fs.mkdirSync(outDir, { recursive: true })
  const manifest = []
  for (const [index, utterance] of TALK_DRIVING_UTTERANCES.entries()) {
    const pcm = await synthesize(apiKey, utterance.synthesis ?? utterance.text, fetchImpl)
    const filename = `${String(index + 1).padStart(2, "0")}-${utterance.id}.wav`
    fs.writeFileSync(path.join(outDir, filename), encodePcmWav(pcm))
    manifest.push({ ...utterance, filename, bytes: pcm.length + 44, sampleRate: SAMPLE_RATE })
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function outputDirectory(argv) {
  const index = argv.indexOf("--out")
  if (index < 0 || !argv[index + 1]) throw new Error("--out <throwaway directory> is required")
  return path.resolve(argv[index + 1])
}

async function main() {
  const outDir = outputDirectory(process.argv)
  const manifest = await generateTalkDrivingAudio(outDir)
  console.log(JSON.stringify({ outDir, files: manifest.map(({ filename }) => filename) }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
