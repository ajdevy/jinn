# PLA-118 platform foundation QA

- Date: 2026-08-20
- Branch: `feature/PLA-118`
- Sandboxes: fresh disposable homes on loopback ports 7802 and 7803
- Production home/port: not used

`Verified` means the listed evidence was exercised. `Unverified` is an explicit
gap, not an inferred pass. Temporary pairing codes, credentials, browser traces,
and sandbox data are not retained.

## Journey ledger

| # | Journey assertion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Boot A, pair, HttpOnly cookies, `/api/sessions` 200 | Verified | Fresh isolated Chrome pairing returned 200 with script-invisible cookies; bundled macOS pairing also succeeded |
| 2 | Open `/todos` and a Todo in the same browser | Verified | Created and opened generic `QAA-1` in the paired Chrome session |
| 3 | Browser workspace switch A→B isolates A authentication | Verified | The switch navigated from A on `127.0.0.1` to B on `localhost`; B returned 401 before its own pairing, and no A cookie was sent across the host boundary |
| 4 | PWA hard-refresh `/todos` and `/settings`; API remains same-origin | Verified | Both routes retained an active controlling service worker and returned same-origin API 200 after reload |
| 5 | Chat, Todos, Settings, switcher screenshots at both sizes/themes | Verified | Sixteen generic PNGs under `docs/qa/PLA-118-evidence/`; dimensions checked as 1440×900 and 390×844 |
| 6 | Bundled Tauri loads local assets; menu/icon/geometry work | Verified | Fresh unsigned macOS `.app` opened its embedded web UI rather than a gateway URL, retained the Jinn/Edit/View/Window menus and app icon metadata, reloaded from View, and resized between 1280×860 and 390×844; configuration tests assert `frontendDist` and `WebviewUrl::App` |
| 7 | Pair A and B independently | Verified | Live bundled app stored two exact-origin Keychain entries; adding B did not activate it |
| 8 | A→B changes HTTP, WS, cache, auth, identity; route remains `/todos` | Verified | Live native A↔B switching showed distinct `QAA-1`/`QAB-1` data while preserving `/todos`; generation isolation tests cover cache and socket state |
| 9 | Delayed A REST and WS after switch are discarded | Verified | Focused test delivered an A REST resolution and A WebSocket frame after committing B; the REST result rejected as stale, the frame callback did not run, and B remained active |
| 10 | B→A, remove B, restore A, honest unreachable state | Verified | Live return showed A's one Todo; removing B left A intact; Reload restored A; Reload while A was down rendered “Failed to check gateway access” |
| 11 | `jinn://org` and `jinn://settings` stay in-app; HTTPS opens outside | Verified | Both custom links were invoked against the unsigned bundle and rendered their in-app routes; navigation tests verify HTTPS is external |
| 12 | Unsupported, denied, and failed remain distinct | Verified | Platform contract suite |
| 13 | Remote/LAN pages cannot invoke native; web bundle has no Tauri or Capacitor dependencies | Verified | Rust caller/origin tests, product-boundary test, and a scan of all 370 emitted JavaScript assets |
| 14 | Full gates, unsigned macOS build, mobile initialization | Verified with named gaps | Full gate green; Apple/Android projects generated; details below |

## Mobile and packaging evidence

| Target | Evidence | Result |
| --- | --- | --- |
| macOS | unsigned bundled application build and launch | Verified; signing/notarization unverified |
| iOS | target initialization; `cargo check --target aarch64-apple-ios-sim` with rustup toolchain | Verified compilation; app packaging blocked because no simulator runtime is installed; device signing team absent |
| Android | target initialization; `cargo check --target aarch64-linux-android` with NDK clang/ar | Verified compilation; Gradle packaging/device run blocked by missing JDK; secure credential persistence unverified |

## Gate record

After the `main` reconciliation, `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm ratchet --check && pnpm footguns` exited 0 in S11, S12, S13, and S14. S14 also reran the exact delayed-delivery case, platform contracts, product boundary, shell configuration, and Rust shell suites: 9 focused web tests, 5 shell configuration tests, and 16 Rust tests passed.

The additional web performance audit scanned all emitted JavaScript assets and
found no Tauri or Capacitor marker. Its unrelated initial-critical-path size
ceiling remains red on the inherited `main` branch (199,638 B gzip against a
195,000 B ceiling); the PLA-118 branch measures 202,707 B. This inherited
non-gate condition is reported rather than hidden or converted into a pass.

## Visual evidence manifest

The manifest contains `chat`, `todos`, `settings`, and `switcher`, each at
`desktop` (1440×900) and `mobile` (390×844), with `light` and `dark` variants.
All sixteen images contain only generic QA-A/QA-B sandbox data.
