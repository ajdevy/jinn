import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as sdk from '@jinn/plugin-sdk'
import { SDK_CONTRACT_VERSION } from '../version'

const SDK_DIR = path.resolve(__dirname, '..')
const CONTRACT = readFileSync(path.join(SDK_DIR, 'sdk.d.ts'), 'utf8')
const BARREL = readFileSync(path.join(SDK_DIR, 'index.ts'), 'utf8')

/** The names `sdk.d.ts` declares as values, which is what a runtime export is. */
function declaredValues(contract: string): string[] {
  return [...contract.matchAll(/^export declare (?:const|function|class) (\w+)/gm)].map(
    (match) => match[1]!,
  )
}

/** The names `sdk.d.ts` declares as types, which nothing exports at runtime. */
function declaredTypes(contract: string): string[] {
  return [...contract.matchAll(/^export (?:type|interface) (\w+)/gm)].map((match) => match[1]!)
}

/** The names the barrel re-exports through `export type { … }`. */
function barrelTypeExports(barrel: string): string[] {
  return [...barrel.matchAll(/export type \{([\s\S]*?)\}/g)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

/** Every module specifier the contract names, in either quote style. */
function importedSpecifiers(contract: string): string[] {
  return [...contract.matchAll(/from (['"])([^'"]+)\1|import\((['"])([^'"]+)\3\)/g)].map(
    (match) => (match[2] ?? match[4])!,
  )
}

/** Whether a relative specifier lands outside the sdk directory. Resolving it
 *  rather than reading its first characters is the point: `./../../lib/x` walks
 *  out just as surely as `../../lib/x` does. */
function escapesSdkDirectory(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false

  const resolved = path.resolve(SDK_DIR, specifier)
  return resolved !== SDK_DIR && !resolved.startsWith(SDK_DIR + path.sep)
}

describe('the SDK re-exports the app’s own instances', () => {
  it('exports the React the app itself resolved', async () => {
    const react = await import('react')

    expect(sdk.React).toBe(react.default)
  })

  it('exports the jsx runtime the app itself resolved', async () => {
    const runtime = await import('react/jsx-runtime')

    expect(sdk.jsx).toBe(runtime.jsx)
    expect(sdk.jsxs).toBe(runtime.jsxs)
  })

  it('exports the app’s single query client', async () => {
    const { queryClient } = await import('@/lib/query-client')

    expect(sdk.queryClient).toBe(queryClient)
  })
})

describe('the contribution areas', () => {
  /* The ids are the wire format: a plugin on disk names them in its manifest,
   * and nothing derives them, so renaming one has to fail here rather than at
   * a stranger's install. */
  it('exports the five v1 area ids', () => {
    expect(new Set(Object.values(sdk.AREAS))).toEqual(
      new Set([
        'routes',
        'sidebar.nav',
        'statusbar.right',
        'todo.detail.actions',
        'todo.detail.sections',
      ]),
    )
  })
})

describe('sdk.d.ts is the public contract and cannot drift from it', () => {
  it('declares exactly the runtime exports of index.ts, and no others', () => {
    expect(declaredValues(CONTRACT).sort()).toEqual(Object.keys(sdk).sort())
  })

  it('declares exactly the types index.ts exports, and no others', () => {
    expect(declaredTypes(CONTRACT).sort()).toEqual(barrelTypeExports(BARREL).sort())
  })

  it('names no module a plugin author could not resolve', () => {
    for (const specifier of importedSpecifiers(CONTRACT)) {
      expect(specifier.startsWith('@/'), `${specifier} is an app-internal path`).toBe(false)
      expect(escapesSdkDirectory(specifier), `${specifier} escapes the sdk directory`).toBe(false)
    }
  })

  /* The firewall above is only worth as much as the two helpers underneath it,
   * and both had a hole a plausible edit walks straight through: a double quote,
   * and a relative path that leaves the directory without opening on `..`. */
  it('catches the app-internal forms a prefix check misses', () => {
    const evasions = ['import type { X } from "@/lib/x"', "import type { Y } from './../../lib/y'"]

    expect(importedSpecifiers(evasions.join('\n'))).toEqual(['@/lib/x', './../../lib/y'])
    expect(escapesSdkDirectory('./../../lib/y')).toBe(true)
    expect(escapesSdkDirectory('./host-state')).toBe(false)
  })

  it('carries the version the SDK itself exports', () => {
    const declared = /export declare const SDK_CONTRACT_VERSION: '([^']+)'/.exec(CONTRACT)?.[1]

    expect(declared).toBe(SDK_CONTRACT_VERSION)
  })
})
