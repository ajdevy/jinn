import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")

export function assertServiceOwnedRemovalsApplied({ home, serviceOwnedRemovals }) {
  for (const removalPath of serviceOwnedRemovals) {
    if (fs.existsSync(path.join(home, removalPath))) {
      throw new Error(`service-owned removal path survived completion: ${removalPath}`)
    }
  }
}

export function assertStockBundleApplied({ home, materializedBundleDir, manifest, receipt, preMergeTree }) {
  if (receipt.skippedItems.length > 0) throw new Error(`stock migration skipped manifest paths: ${JSON.stringify(receipt.skippedItems)}`)
  const reviewed = new Set(receipt.reviewedFiles)
  for (const record of manifest.files) {
    // A removal is service-owned and has not happened yet: the service performs it at
    // completion. assertServiceOwnedRemovalsApplied proves it there.
    if (record.operation === "remove") continue
    if (!reviewed.has(record.path)) throw new Error(`stock migration did not review manifest path: ${record.path}`)
    const user = path.join(home, record.path)
    if (!fs.existsSync(user)) throw new Error(`stock path is missing after migration: ${record.path}`)
    const actualSha256 = sha256(fs.readFileSync(user))
    const baseSha256 = record.basePayload ? sha256(fs.readFileSync(path.join(materializedBundleDir, record.basePayload))) : null
    const targetSha256 = record.targetPayload ? sha256(fs.readFileSync(path.join(materializedBundleDir, record.targetPayload))) : null
    const wasUnmodifiedStock = record.operation === "add" || preMergeTree[record.path] === baseSha256
    if (wasUnmodifiedStock && actualSha256 !== targetSha256) {
      throw new Error(`stock path did not reach target: ${record.path}`)
    }
    if (!wasUnmodifiedStock && baseSha256 !== targetSha256 && actualSha256 === preMergeTree[record.path]) {
      throw new Error(`personalized stock path did not incorporate target changes: ${record.path}`)
    }
  }
}
