# PLA-118 platform foundation QA

- Date: 2026-08-22
- Branch: `feature/PLA-118`
- Product SHA exercised: `730b52bdc31b`; rework round exercised the working tree whose parent is `fc767857`
- Sandboxes: fresh disposable `qa-pla-118-a` / `qa-pla-118-b` homes on loopback ports 7810 and 7811; the rework round re-ran the step 10 journey on disposable homes at loopback ports 7812 and 7813
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
| 10 | B→A, remove B, restore A, honest unreachable state | Verified | Live return preserved the open route; removing a gateway deleted only that exact-origin credential and left the other intact; relaunch restored the last-active gateway. With the last-active gateway stopped, a live relaunch renders the native gateway screen ("Cannot reach QA Alpha", both paired gateways with Retry/Use/Remove, and the origin field) instead of the browser pairing screen, and selecting the other paired gateway recovered into it. Focused manager cases cover the unreachable selection, the unproven remembered gateway, and the in-flight switch id |
| 11 | `jinn://org` and `jinn://settings` stay in-app; HTTPS opens outside | Verified | Both custom links were invoked against the unsigned bundle and rendered their in-app routes; the Rust navigation suite verifies HTTPS is handed to the external opener |
| 12 | Unsupported, denied, and failed remain distinct | Verified | Platform contract suite |
| 13 | Remote/LAN pages cannot invoke native; web bundle has no Tauri or Capacitor dependencies | Verified | Rust caller/origin tests, product-boundary test, zero Capacitor lockfile entries, and emitted JavaScript scans |
| 14 | Full gates, unsigned macOS build, mobile initialization | Verified with named gaps | Full gate green; Apple/Android projects generated; details below |

## Mobile and packaging evidence

| Target | Evidence | Result |
| --- | --- | --- |
| macOS | unsigned bundled application build and launch | Verified: `cargo tauri build --bundles app` produced `Jinn.app` and the launched window rendered its own Connect Jinn gateway screen from the bundled local assets with the Jinn/Edit/View/Window menu bar intact. Developer ID signing, notarization, packaging beyond the ad-hoc `.app`, and distribution are unverified |
| iOS | `cargo check --target aarch64-apple-ios-sim` on the rustup `stable-aarch64-apple-darwin` toolchain | Verified Rust compilation (exit 0). Xcode app packaging, simulator launch, physical device behavior, signing team, and distribution signing are unverified |
| Android | `cargo check --target aarch64-linux-android` against NDK 27.3.13750724 | Verified Rust compilation (exit 0). Gradle APK/AAB packaging, emulator/device launch, keystore signing, and Play distribution are unverified |

## Gate record

After the `main` reconciliation, `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm ratchet --check && pnpm footguns` exited 0 in S15, S16, and S17. S18 reran the native delayed-delivery/profile contracts, platform contracts, product boundary, shell configuration, and Rust shell suites: the web wrapper completed 348 files / 3,073 tests, the shell configuration completed 5 tests, and the Rust library completed 16 tests, all with exit code 0. The final six-gate S18 run is recorded in the slice checkpoint. The rework round re-ran the same six gates after its final edit: typecheck, lint, test, build, `ratchet --check`, and footguns each exited 0, read from each command's own exit code.

## Visual evidence manifest

The manifest contains `chat`, `todos`, `settings`, and `switcher`, each at
`desktop` (1440×900) and `mobile` (390×844), with `light` and `dark` variants.
Four additional `native-profile` captures record the unsigned app's own gateway
screen with its last-active gateway unreachable at the same two sizes/themes.
All twenty images contain only generic QA sandbox data.
