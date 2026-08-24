import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")

function payloadSha256(materializedBundleDir, payload) {
  if (!payload) return null
  return sha256(fs.readFileSync(path.join(materializedBundleDir, payload)))
}

export function assertServiceOwnedRemovalsApplied({ home, serviceOwnedRemovals }) {
  for (const removalPath of serviceOwnedRemovals) {
    if (fs.existsSync(path.join(home, removalPath))) {
      throw new Error(`service-owned removal path survived completion: ${removalPath}`)
    }
  }
}

function assertStockRecordHashes({ actualSha256, baseSha256, targetSha256, record, preMergeTree }) {
  const wasUnmodifiedStock = record.operation === "add" || preMergeTree[record.path] === baseSha256
  if (wasUnmodifiedStock) {
    if (actualSha256 !== targetSha256) throw new Error(`stock path did not reach target: ${record.path}`)
    return
  }
  if (baseSha256 !== targetSha256 && actualSha256 === preMergeTree[record.path]) {
    throw new Error(`personalized stock path did not incorporate target changes: ${record.path}`)
  }
}

function assertStockRecordApplied({ home, materializedBundleDir, record, reviewed, preMergeTree }) {
  // A removal is service-owned and has not happened yet: the service performs it at
  // completion. assertServiceOwnedRemovalsApplied proves it there.
  if (record.operation === "remove") return
  if (!reviewed.has(record.path)) throw new Error(`stock migration did not review manifest path: ${record.path}`)
  const user = path.join(home, record.path)
  if (!fs.existsSync(user)) throw new Error(`stock path is missing after migration: ${record.path}`)
  const actualSha256 = sha256(fs.readFileSync(user))
  const baseSha256 = payloadSha256(materializedBundleDir, record.basePayload)
  const targetSha256 = payloadSha256(materializedBundleDir, record.targetPayload)
  assertStockRecordHashes({ actualSha256, baseSha256, targetSha256, record, preMergeTree })
}

export function assertStockBundleApplied({ home, materializedBundleDir, manifest, receipt, preMergeTree }) {
  if (receipt.skippedItems.length > 0) throw new Error(`stock migration skipped manifest paths: ${JSON.stringify(receipt.skippedItems)}`)
  const reviewed = new Set(receipt.reviewedFiles)
  for (const record of manifest.files) {
    assertStockRecordApplied({ home, materializedBundleDir, record, reviewed, preMergeTree })
  }
}
