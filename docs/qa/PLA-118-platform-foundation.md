# PLA-118 platform foundation QA

- Date: 2026-08-22
- Branch: `feature/PLA-118`
- Product SHA exercised: `730b52bdc31b`
- Sandboxes: fresh disposable `qa-pla-118-a` / `qa-pla-118-b` homes on loopback ports 7810 and 7811
- Production home/port: not used

`Verified` means the listed evidence was exercised. `Unverified` is an explicit
gap, not an inferred pass. Temporary pairing codes, credentials, browser traces,
and sandbox data are not retained.

## Journey ledger

| # | Journey assertion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Boot A, pair, HttpOnly cookies, `/api/sessions` 200 | Verified | Fresh isolated Chrome pairing returned 200; `document.cookie` could not see either cookie, while CDP reported both as HttpOnly; bundled macOS pairing also succeeded |
| 2 | Open `/todos` and a Todo in the same browser | Verified | Opened generic `QPA-1` in the paired Chrome session with the existing dashboard chrome intact |
| 3 | Browser workspace switch A→B isolates A authentication | Verified | The switch navigated from A on `127.0.0.1` to B on `localhost`; B returned 401 before its own pairing, and no A cookie was sent across the host boundary |
| 4 | PWA hard-refresh `/todos` and `/settings`; API remains same-origin | Verified | Both routes retained an active controlling service worker and returned same-origin API 200 after reload |
| 5 | Chat, Todos, Settings, switcher screenshots at both sizes/themes | Verified | Twenty current generic PNGs under `docs/qa/PLA-118-evidence/`: the required sixteen browser captures plus four bundled-native profile lifecycle captures; every file is exactly 1440×900 or 390×844 |
| 6 | Bundled Tauri loads local assets; menu/icon/geometry work | Verified | Fresh unsigned macOS `.app` opened its embedded pairing UI before any gateway profile existed, retained the Jinn/Edit/View/Window menu configuration and app icon metadata, and resized between 1440×900, 1280×860, and 390×844; shell tests assert `frontendDist` and `WebviewUrl::App` |
| 7 | Pair A and B independently | Verified | Live bundled app stored two exact-origin Keychain entries; adding B did not activate it |
| 8 | A→B changes HTTP, WS, cache, auth, identity; route remains `/todos` | Verified | Live native A↔B switching showed distinct `QPA-1`/`QPB-1` identity and preserved the Todos Home route in both directions; generation isolation tests cover cache and socket state |
| 9 | Delayed A REST and WS after switch are discarded | Verified | Focused test delivered an A REST resolution and A WebSocket frame after committing B; the REST result rejected as stale, the frame callback did not run, and B remained active |
| 10 | B→A, remove B, restore A, honest unreachable state | Verified | Live return preserved `/todos`; removing B deleted only B's exact-origin credential and left A intact; relaunch restored A. The focused manager case rejects an unreachable selection, retains the prior active profile, and exposes `status: "unreachable"` rather than pretending the switch succeeded |
| 11 | `jinn://org` and `jinn://settings` stay in-app; HTTPS opens outside | Verified | Both custom links were invoked against the unsigned bundle and rendered their in-app routes; the Rust navigation suite verifies HTTPS is handed to the external opener |
| 12 | Unsupported, denied, and failed remain distinct | Verified | Platform contract suite |
| 13 | Remote/LAN pages cannot invoke native; web bundle has no Tauri or Capacitor dependencies | Verified | Rust caller/origin tests, product-boundary test, zero Capacitor lockfile entries, and emitted JavaScript scans |
| 14 | Full gates, unsigned macOS build, mobile initialization | Verified with named gaps | Full gate green; Apple/Android projects generated; details below |

## Mobile and packaging evidence

| Target | Evidence | Result |
| --- | --- | --- |
| macOS | unsigned bundled application build and launch | Verified ad-hoc bundle and live launch; Developer ID signing, notarization, and distribution are unverified |
| iOS | initialized Apple target and `cargo check --target aarch64-apple-ios-sim` with the rustup toolchain | Verified Rust compilation; Xcode app packaging, simulator launch, physical device behavior, signing team, and distribution signing are unverified |
| Android | initialized Android target and `cargo check --target aarch64-linux-android` with an official disposable NDK toolchain | Verified Rust compilation; Gradle APK/AAB packaging, emulator/device launch, keystore signing, and Play distribution are unverified |

## Gate record

After the `main` reconciliation, `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm ratchet --check && pnpm footguns` exited 0 in S15, S16, and S17. S18 reran the native delayed-delivery/profile contracts, platform contracts, product boundary, shell configuration, and Rust shell suites: the web wrapper completed 348 files / 3,073 tests, the shell configuration completed 5 tests, and the Rust library completed 16 tests, all with exit code 0. The final six-gate S18 run is recorded in the slice checkpoint.

## Visual evidence manifest

The manifest contains `chat`, `todos`, `settings`, and `switcher`, each at
`desktop` (1440×900) and `mobile` (390×844), with `light` and `dark` variants.
Four additional `native-profile` captures record the unsigned app's local
pairing and connected-profile surfaces at the same two sizes/themes. All twenty
images contain only generic QA sandbox data.
