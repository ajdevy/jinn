# PLA-118 platform foundation QA

- Date: 2026-08-18
- Branch: `feature/PLA-118`
- Sandboxes: disposable homes on loopback ports 7792 and 7793
- Production home/port: not used

`Verified` means the listed evidence was exercised. `Unverified` is an explicit
gap, not an inferred pass. Temporary pairing codes, credentials, browser traces,
and sandbox data are not retained.

## Journey ledger

| # | Journey assertion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Boot A, pair, HttpOnly cookies, `/api/sessions` 200 | Verified | Isolated Chrome pairing returned 200 with script-invisible cookies; bundled macOS pairing also succeeded |
| 2 | Open `/todos` and a Todo in the same browser | Verified | Created and opened generic `QAA-1`; hard refresh preserved `/todos/QAA-1` |
| 3 | Browser workspace switch A→B isolates A authentication | Verified with protocol note | B returned 401 before its own pairing; after pairing, distinct HttpOnly cookie names kept both origins usable. RFC cookies are host-, not port-scoped, so an unknown A cookie name may transit to B but B cannot select it |
| 4 | PWA hard-refresh `/todos` and `/settings`; API remains same-origin | Verified | Both routes retained an active controlling service worker and returned same-origin API 200 after reload |
| 5 | Chat, Todos, Settings, switcher screenshots at both sizes/themes | Verified | Sixteen generic PNGs under `docs/qa/PLA-118-evidence/`; dimensions checked as 1440×900 and 390×844 |
| 6 | Bundled Tauri loads local assets; menu/icon/geometry work | Verified | Fresh unsigned macOS `.app` opened the bundled pairing UI at saved 1280×860 geometry; configuration test asserts `WebviewUrl::App` |
| 7 | Pair A and B independently | Verified | Live bundled app stored two exact-origin Keychain entries; adding B did not activate it |
| 8 | A→B changes HTTP, WS, cache, auth, identity; route remains `/todos` | Verified | Live `/settings` A→B and `/todos` B→A runs changed portal identity/data without changing the route; generation isolation tests cover cache and socket state |
| 9 | Delayed A REST and WS after switch are discarded | Verified | Profile-manager deferred response and late-frame tests |
| 10 | B→A, remove B, restore A, honest unreachable state | Verified | Live return showed A's one Todo; removing B deleted only B's Keychain item; relaunch restored A; relaunch while A was down rendered “Failed to check gateway access” |
| 11 | `jinn://org` and `jinn://settings` stay in-app; HTTPS opens outside | Verified | Both custom links were invoked against the unsigned bundle and rendered their in-app routes; navigation tests verify HTTPS is external |
| 12 | Unsupported, denied, and failed remain distinct | Verified | Platform contract suite |
| 13 | Remote/LAN pages cannot invoke native; web bundle has no native dependencies | Verified | Rust caller/origin tests and emitted-asset dependency scan |
| 14 | Full gates, unsigned macOS build, mobile initialization | Verified with named gaps | Full gate green; Apple/Android projects generated; details below |

## Mobile and packaging evidence

| Target | Evidence | Result |
| --- | --- | --- |
| macOS | unsigned bundled application build and launch | Verified; signing/notarization unverified |
| iOS | target initialization; `cargo check --target aarch64-apple-ios-sim` with rustup toolchain | Verified compilation; app packaging blocked because no simulator runtime is installed; device signing team absent |
| Android | target initialization; `cargo check --target aarch64-linux-android` with NDK clang/ar | Verified compilation; Gradle packaging/device run blocked by missing JDK; secure credential persistence unverified |

## Gate record

After S6, `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm ratchet --check && pnpm footguns` exited 0. The gate included 5,041 passing CLI tests (7 skipped), 2,598 passing web tests, 5 shell configuration tests, 16 Rust shell tests, 96 root Node tests, and 92 POSIX tests. Ratchet scanned 1,727 files with no violations; footguns scanned 82 files with no violations or suppressions. The web budget passed at 192,592 B gzip initial, 17,242 B task page, and 24,714 B board page while scanning 356 emitted JavaScript assets for native-runtime markers.

## Visual evidence manifest

The manifest contains `chat`, `todos`, `settings`, and `switcher`, each at
`desktop` (1440×900) and `mobile` (390×844), with `light` and `dark` variants.
All sixteen images contain only generic QA-A/QA-B sandbox data.
