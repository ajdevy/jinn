import { spawn } from "node:child_process"

const LOWEST_SIGNALLABLE_PID = 500
const CHILD_ARGS = ["-e", "setInterval(() => {}, 60000)"]

export function spawnSignallableChild() {
  const discarded = []
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const child = spawn(process.execPath, CHILD_ARGS, { stdio: "ignore" })
    if ((child.pid ?? 0) >= LOWEST_SIGNALLABLE_PID) {
      for (const lowPidChild of discarded) lowPidChild.kill("SIGKILL")
      return child
    }
    discarded.push(child)
  }
  for (const lowPidChild of discarded) lowPidChild.kill("SIGKILL")
  throw new Error(`could not obtain a child PID >= ${LOWEST_SIGNALLABLE_PID}`)
}
