// What counts as a privacy leak, and where the terms that define one come from.
//
// This repository is public and ships to npm, so a real address or a private
// name on a committed line is a live leak. Everything below is a carve-out for
// the strings that only look like one: a reserved documentation domain, a
// version spec that is @-shaped, and a lockfile, whose addresses arrive from
// the registry rather than from anyone here.
import { readFileSync } from "node:fs"

export const PRIVATE_TERMS_DEFAULT = "scripts/.footgun-terms.local"

// An address in a lockfile belongs to a package's npm deprecation notice or to
// an scp-style git URL: it is copied in verbatim, the only edit that could
// remove it is dropping the dependency, and pnpm rewrites the file on every
// install so a suppression comment would not survive. Private terms still
// count — a private repository in a resolution URL is ours, and is a real leak.
const GENERATED_LOCKFILE = /(?:^|\/)pnpm-lock\.yaml$/

/**
 * An email on a domain nobody owns is documentation, not a leak. Anything under
 * an `example` label or a reserved TLD is illustrative by RFC 2606 / 6761.
 */
function isIllustrativeDomain(domain) {
  const labels = domain.toLowerCase().split(".")
  const tld = labels[labels.length - 1]
  // `typescript@5.9.3` in a lockfile is email-shaped and is not an address. A
  // real top-level domain is letters.
  if (!/^[a-z]{2,}$/.test(tld)) return true
  if (["example", "invalid", "test", "local", "localhost", "internal"].includes(tld)) return true
  return labels.includes("example")
}

// A local part with no letter in it is an identifier that happens to be
// @-shaped — a WhatsApp JID, a docker tag — not a person's address.
const EMAIL = /\b[A-Za-z0-9._%+-]*[A-Za-z][A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g

// Apple asset catalogs conventionally encode the pixel scale in filenames
// such as `AppIcon-20x20@2x.png`. That suffix is not an address, and generated
// mobile projects contain many of them.
const ASSET_SCALE_SUFFIX = /@\d+x(?:-\d+)?\.(?:gif|jpe?g|png|svg|webp)$/i

export function findLeaks(text, relPath, privateTerms) {
  const readsAddresses = !GENERATED_LOCKFILE.test(relPath)
  const found = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const leaks =
      readsAddresses &&
      [...line.matchAll(EMAIL)].some(
        (match) => !ASSET_SCALE_SUFFIX.test(match[0]) && !isIllustrativeDomain(match[1]),
      )
    const lower = line.toLowerCase()
    if (leaks || privateTerms.some((term) => lower.includes(term))) found.push(index + 1)
  }
  return found
}

export function loadPrivateTerms() {
  // A deny-list of real names committed to a public repo IS the leak, so the
  // terms live outside the tree. Absent, the rule runs structurally only, and
  // the summary says so rather than downgrading in silence.
  const configured = process.env.FOOTGUN_TERMS_FILE
  const file = configured ?? PRIVATE_TERMS_DEFAULT
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT" && !configured) return []
    throw new Error(`FOOTGUN_TERMS_FILE ${file} could not be read: ${error.message}`)
  }
  return raw
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}
