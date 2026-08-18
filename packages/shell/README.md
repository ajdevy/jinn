# @jinn/shell

The Tauri 2 shell for Jinn desktop and mobile targets. It bundles the production
web dashboard; it never navigates the main webview to a gateway URL.

## Security boundary

On Apple platforms, gateway credentials live in Keychain, scoped to the exact
canonical origin including its port. Android credential persistence is not yet
release-verified and must not be represented as secure storage support. The
bundled dashboard can call four application commands only: `pair`, `request`,
`stream`, and `forget`.
Those commands accept root-relative gateway paths, reject credential-bearing
headers and redirects, and return no cookie or token to JavaScript.

Plain HTTP gateways are accepted only on literal loopback addresses. LAN,
tailnet, and remote gateways require HTTPS. Every command also verifies that it
came from the local `main` window; the probe and any remote document fail
closed. Tauri capabilities contain no `remote` grants.

The strict CSP permits bundled assets and Tauri IPC only. Gateway REST and
WebSocket traffic runs in Rust, so gateway origins do not appear in
`connect-src`. External HTTP(S) links open in the system browser.

## Build

Prerequisites are pnpm, Rust, and Tauri CLI 2.

```sh
pnpm --filter @jinn/shell test
pnpm --filter @jinn/shell desktop:build
pnpm --filter @jinn/shell ios:init
pnpm --filter @jinn/shell android:init
```

`desktop:build` first builds `@jinn/web`, atomically stages that output with the
refresh probe, then creates the native bundle. The macOS unsigned app is written
under `src-tauri/target/release/bundle/macos/`.

Signing, notarization, store distribution, and device deployment are release
concerns and are not implied by a successful local unsigned build.

The generated Apple and Android projects are committed under `src-tauri/gen/`.
Initialization does not prove device execution: Apple device builds still need
a development team, while Android requires a supported JDK/SDK/NDK toolchain
and a real credential-store backend before release.

## Retained desktop behavior

The native menu, icon, restored window geometry, `jinn://` deep links, and the
opt-in refresh-rate probe from the desktop spike remain. `jinn://org` and other
custom-scheme routes resolve inside bundled assets. Set `JINN_SHELL_PROBE=1`
when launching the shell to open the local probe window.
