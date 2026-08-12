/**
 * The runtime half of the two delivery modes in `.plans/plugins.md` §4.
 *
 * A bundled plugin resolves `@jinn/plugin-sdk` through the Vite alias. A disk
 * `client.js` writes the same specifier and has to land on the same object, so
 * the loader installs the live namespaces on globals and rewrites the specifier
 * to a shim module that reads them back off `globalThis`. React is the
 * mechanism rather than a convenience: a plugin that resolved a second React
 * would get a second dispatcher and every hook it called would throw.
 *
 * Export names are derived from the namespace instead of listed here, so adding
 * an export to the SDK barrel cannot leave the shim behind.
 */
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as sdk from './index'

/** The three specifiers a plugin may import, each with the global its shim
 *  reads. Membership is the allowlist the loader rejects against. */
const SDK_GLOBALS = {
  '@jinn/plugin-sdk': { key: '__JINN_PLUGIN_SDK__', namespace: sdk },
  react: { key: '__JINN_REACT__', namespace: React },
  'react/jsx-runtime': { key: '__JINN_REACT_JSX__', namespace: jsxRuntime },
} as const

/** A name a shim can destructure. Anything else would be a syntax error in the
 *  generated module, and no import could have named it anyway. */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/

/** Install the app's own instances where the shims read them. Idempotent. */
export function installPluginSdk(): void {
  for (const { key, namespace } of Object.values(SDK_GLOBALS)) {
    Object.assign(globalThis, { [key]: namespace })
  }
}

/**
 * A shim module that re-exports one global namespace's live members. Exported
 * so a test can hand it a namespace and read the names back, which is the only
 * way to prove the list is derived rather than written down.
 */
export function shimSource(globalKey: string, namespace: object): string {
  const names = Object.keys(namespace).filter(
    (name) => name !== 'default' && BINDING_NAME.test(name),
  )

  return (
    `const m = globalThis.${globalKey};\n` +
    `export default m.default ?? m;\n` +
    // `export const { } = m` is a syntax error, so a namespace with nothing to
    // destructure emits no destructuring at all.
    (names.length > 0 ? `export const { ${names.join(', ')} } = m;\n` : '')
  )
}

let cached: Record<string, string> | null = null

/**
 * Specifier to shim URL, for the loader's rewrite. Built once per tab and never
 * revoked: every rewritten plugin points at these URLs for as long as it is
 * loaded, so a second set would strand the first plugin's imports.
 */
export function sdkImportMap(): Record<string, string> {
  cached ??= Object.fromEntries(
    Object.entries(SDK_GLOBALS).map(([specifier, { key, namespace }]) => [
      specifier,
      URL.createObjectURL(new Blob([shimSource(key, namespace)], { type: 'text/javascript' })),
    ]),
  )

  return cached
}
