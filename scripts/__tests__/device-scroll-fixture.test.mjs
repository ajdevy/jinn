import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { test } from "node:test"

import { assertDisposableHome, reachableAddresses } from "../device-scroll-fixture.mjs"

const disposable = path.join(os.tmpdir(), ".jinn-qa-flick")

test("refuses the production instance home whatever port it carries", () => {
  const home = path.join(os.homedir(), ".jinn")
  assert.throws(() => assertDisposableHome(home, { gateway: { port: 7999 } }), /production instance home/)
})

test("refuses a home configured on the production or demo gateway port", () => {
  for (const port of [7777, 7788]) {
    assert.throws(
      () => assertDisposableHome(disposable, { gateway: { port } }),
      new RegExp(`port ${port}, which is a protected gateway`),
      `port ${port} should be refused`,
    )
  }
})

test("accepts a throwaway home on a free port, and one with no port yet", () => {
  assert.doesNotThrow(() => assertDisposableHome(disposable, { gateway: { port: 7782 } }))
  assert.doesNotThrow(() => assertDisposableHome(disposable, {}))
})

test("lists routable IPv4 addresses only, tailnet first", () => {
  const addresses = reachableAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  })
  assert.deepEqual(addresses, ["100.101.102.103", "192.168.1.20"])
})
