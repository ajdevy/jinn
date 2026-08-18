# Platform capabilities

Jinn's product code asks for typed platform intents. It does not read browser or
native globals directly. The contract lives in
`packages/web/src/platform/contracts.ts`; adapters live under
`packages/web/src/platform/adapters/`.

## Result semantics

These outcomes are deliberately different:

- `unsupported`: no adapter implements the intent in this runtime.
- `permission-required`: the capability exists but needs a user gesture or
  permission prompt.
- `denied`: the user or operating system refused permission.
- `cancelled`: the user abandoned an otherwise supported operation.
- `failed`: an implemented operation encountered an error.

Unsupported intents resolve normally and never throw. Adapter exceptions are
normalized to `failed`.

## Capability matrix

`Conditional` means the web API must exist and, where applicable, the document
must be a secure context. `Shell boundary` means the native window implements
the behavior even though the product intent adapter remains unsupported.

| Intent family | Browser | Installed PWA | Tauri macOS | Tauri iOS | Tauri Android |
| --- | --- | --- | --- | --- | --- |
| feedback | Conditional vibration | Conditional vibration | Unsupported | Unsupported | Unsupported |
| notifications | Conditional + permission | Conditional + permission | Unsupported | Unsupported | Unsupported |
| badges | Conditional | Conditional | Unsupported | Unsupported | Unsupported |
| sharing | Conditional Web Share | Conditional Web Share | Unsupported | Unsupported | Unsupported |
| lifecycle | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| navigation | External URL supported | External URL supported | Shell boundary verified | Shell boundary unverified | Shell boundary unverified |
| viewport | Keyboard inset conditional; orientation unsupported | Same | Unsupported | Unsupported | Unsupported |
| clipboard | Conditional secure-context API | Conditional secure-context API | Unsupported | Unsupported | Unsupported |
| files | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| install | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| window | Unsupported | Unsupported | Geometry/menu internal only | Unsupported | Unsupported |
| device | Unsupported | Unsupported | Product intent unsupported; gateway auth uses Keychain internally | Product intent unsupported; Keychain path cross-compiles | Unsupported; secure persistence unverified |

The table describes shipped code, not desired parity. Update it in the same
change that implements and verifies a capability.

## Adding an intent

1. Add the intent and, if observable, event to `contracts.ts`. Keep the result
   taxonomy; do not encode denial or failure as unsupported.
2. Add a contract test proving fallback behavior and the expected result state.
3. Implement the narrowest adapter that owns the platform API. Browser APIs go
   in `adapters/web.ts`; native behavior goes behind the lazy Tauri adapter.
4. Expose a product-level wrapper near the owning feature. Product modules may
   call `getPlatform()`, but must not read native globals or capability APIs
   directly.
5. Update the capability matrix and add platform-specific verification. Device
   or signing gaps stay `unverified`; compilation is not device proof.
6. Build the production web output and run `pnpm --filter @jinn/web perf:budget`
   so forbidden native dependencies cannot enter emitted assets.

The product-boundary test enforces step 4. Runtime detection remains centralized
in `platform/runtime.ts`, and the lazy adapter keeps native-only code off the
browser's initial path.
