# @jinn/shell-desktop

A Tauri 2 shell that runs the existing web dashboard as a native macOS app. It
is a **spike**: enough to build, run, measure and judge, not a signed,
distributable, auto-updating app.

## Status

It builds and runs on this machine, unlike the iOS spike beside it. What works:

- One window on the operator's gateway, with no address bar, no tabs and no
  browser toolbar. The window's accessibility tree holds a web area, three
  traffic-light buttons and a title, and nothing else.
- A real app icon in the Dock, generated from the web app's own mark.
- A macOS menu bar: **Jinn** (About, Services, Hide, Quit), **Edit** (Undo,
  Redo, Cut, Copy, Paste, Select All), **View** (Reload ⌘R, Toggle Full Screen),
  **Window** (Minimize, Zoom, Close Window).
- Window position and size survive a quit. Moved to 140,210 at 900×640, quit,
  relaunched: restored to 140,210 at 900×640, against config defaults of 320,56
  at 1280×860.
- `jinn://` deep links open a named route. `open jinn://org` moved a running
  shell off the default chat route; `open jinn://settings` cold-started the app
  straight onto Settings. The scheme registered with LaunchServices **without
  signing** — `claimed schemes: jinn:`, bound to `run.jinn.shell.desktop`.

What is not answered: whether the webview is capped at 60Hz. See
[Measuring it](#measuring-it).

## How it loads the app

The shell does **not** bundle the web build. It points a WKWebView at the
operator's own running gateway, through `app.windows[].url`, which
`tauri.config.ts` generates from `JINN_SHELL_SERVER_URL` at sync time.

That is forced by the existing code rather than chosen for convenience. The web
app derives its API base from `window.location.origin`
(`packages/web/src/lib/auth.ts`), opens its event and plugin sockets same-origin
(`packages/web/src/lib/ws.ts`, `packages/web/src/plugins/plugin-context.ts`),
authenticates with `HttpOnly; SameSite=Lax` cookies
(`packages/jinn/src/gateway/auth.ts`), and talks to a gateway whose CORS check
rejects any non-`http(s)` origin (`packages/jinn/src/gateway/server.ts`).

Serving the bundle from Tauri's custom protocol breaks that, and it breaks
differently per platform, which is worth writing down because the two failures
have different fixes:

- **macOS**, origin `tauri://localhost`: the gateway's scheme allowlist rejects
  it outright, so every `/api` call returns 403 `Origin not allowed`. The
  hostname would have been accepted; the scheme never gets that far.
- **Windows**, origin `http://tauri.localhost`: CORS *passes*, because the host
  ends in `.localhost`. The cookies are the problem instead — `SameSite=Lax`
  means the session cookie is never sent from an origin that is not the
  gateway's own.

Loading the gateway's origin keeps all four true on both, and needs no change to
auth, to CORS, or to the web bundle. The cost is real: the app is inert whenever
the gateway is unreachable, and it shows a blank window rather than an error
when that happens.

## First run asks to be paired

The shell shows the gateway's **Private network / Remote access code** screen the
first time, not the dashboard. That is correct behaviour rather than a bug, and
it is a consequence of the choice above.

`POST /api/auth/bootstrap` requires a single-use grant that the CLI embeds when
it opens a browser itself; loopback alone is deliberately not treated as
identity. A Tauri window has no such grant and its own empty cookie jar, so it
arrives exactly as a second browser does. Pair it once:

```sh
jinn pair                     # prints a code, valid 5 minutes, single-use
```

and type the code into the shell. The session then persists across relaunches.
Wiring the grant into the shell would mean a change to gateway auth, which this
spike is explicitly not making — it is a follow-up if the shell is adopted.

## Prerequisites

- macOS. This crate is macOS-only by decision: the menu uses predefined items
  only AppKit provides, and the spike's question is a macOS one. Windows and
  Linux would need `cfg` guards around the Services and Fullscreen items, and
  their own deep-link registration.
- A Rust toolchain, and the Tauri CLI:

  ```sh
  cargo install tauri-cli --version "^2.0" --locked
  ```

  It installs to `~/.cargo/bin`, which Homebrew's Rust does not put on `PATH`.
  Add it, or `cargo tauri` will not be found.
- A running gateway.

## Running it

```sh
# The gateway to load. Its address, not a placeholder:
export JINN_SHELL_SERVER_URL=http://192.0.2.10:7778

pnpm --filter @jinn/shell-desktop desktop:dev     # run it
pnpm --filter @jinn/shell-desktop desktop:build   # build Jinn.app
```

Both run `desktop:sync` first, which writes `src-tauri/tauri.conf.gen.json` from
that variable. The variable is not optional and its absence is fatal on purpose:
a shell silently pointed at the wrong origin looks identical to one that works
until it does not. Unset, it stops with

```
JINN_SHELL_SERVER_URL is unset, so there is no gateway for the shell to load.
Set it to the gateway's address and re-run, e.g.
JINN_SHELL_SERVER_URL=http://192.0.2.10:7778 pnpm --filter @jinn/shell-desktop desktop:dev
```

A value that is not a URL, or one whose scheme is not `http(s)`, fails the same
way. `tauri.config.test.ts` covers all four cases.

To regenerate the icons from the web app's mark:

```sh
cargo tauri icon ../web/public/icons/icon-512.png   # from packages/shell-desktop/src-tauri
```

Only two of the files it writes are kept: `icon.icns`, which is what macOS
bundles, and `icon.png`, which Tauri requires as the default window icon. The
iOS, Android and Windows sets are deleted, as are the intermediate PNG slots —
macOS reads none of them, and the retina one's filename joins a name and an
extension with an `@`, which `pnpm footguns` reports as an email address.

## Measuring it

The research note behind this spike says macOS 26 removed the WKWebView 60Hz
`requestAnimationFrame` cap. `scripts/refresh-rate-probe.js` checks that on the
machine instead of trusting it.

A measured rate alone cannot answer the question — a 60Hz display and a webview
pinned to 60 read identically — so the shell publishes the display's own maximum
as `window.__jinnDisplayHz`, from `NSScreen.maximumFramesPerSecond`
(`src-tauri/src/display.rs`). No web API exposes it.

```sh
JINN_SHELL_PROBE=1 pnpm --filter @jinn/shell-desktop desktop:dev
```

opens a blank local window alongside the main one, runs the probe in it, prints
one JSON line and quits. It is the variable rather than a third script because
`desktop:dev` and `desktop:build` are the only two entry points into Rust, and
an instrument does not earn a third. The probe itself knows nothing about
Tauri: it prints through `console.log`, and the shell forwards what it printed,
so the same file also works pasted into a Web Inspector console.

Real output from this machine:

```json
{"probe":"refresh-rate-probe","userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)","devicePixelRatio":1,"measuredRafHz":60,"displayHz":60,"verdict":"indeterminate","reason":"the display runs at 60Hz, so a webview pinned to 60Hz and one at the display's native rate produce the same reading — this machine cannot answer the question","frames":120,"durationMs":2000,"medianIntervalMs":17,"maxIntervalMs":22}
```

**The question is unanswered, and this machine cannot answer it.** Its only
display is 1920×1080 at 60Hz, so a webview honouring the panel and a webview
pinned to 60 produce the same 60Hz reading. The probe says so rather than
reporting a pass. Re-run it on a ProMotion display: `verdict` becomes `uncapped`
if the reading tracks 120Hz, `capped` if it sits at 60.

The two numbers agreeing is still worth something — AppKit's 60 matches
`system_profiler`'s 60, so the instrument is reading the right display.

This is not `shell-ios/scripts/frame-probe.js`. That one asks whether a WebView
scrolls worse than a PWA, against a fixed 60Hz baseline, on the chat transcript.
Here 60Hz is the assumption under test and there is no second run to compare
against. Two probes, no shared abstraction.

## Auto-update: the options, none of them built

Nothing here updates itself. The choice, and what each costs:

- **Tauri's updater plugin.** Built for this, cross-platform, and the app checks
  a JSON endpoint and swaps itself. It needs a signing key pair whose private
  half signs every release, a static endpoint to publish manifests to, and — on
  macOS — a Developer ID signature and notarisation, because an update that
  replaces an app bundle with an unsigned one is refused by Gatekeeper. Roughly
  a day of release plumbing on top of the enrolment below.
- **Sparkle.** The macOS standard, better appcast tooling, delta updates. It is
  an Objective-C framework with no first-party Tauri binding, so it means Swift
  or objc2 glue this crate does not currently need, and it solves only macOS.
  Worth it only if the shell is macOS-only forever *and* update UX matters more
  than one platform's worth of effort.
- **Distribute through the CLI only** — `jinn` already installs from npm and
  Homebrew, so the shell could ship as an artifact the CLI downloads and
  replaces on `jinn upgrade`. No new signing infrastructure beyond notarisation,
  no new endpoint, and updates arrive on the cadence the operator already
  accepts. It makes the desktop app a strict dependent of the CLI, which it
  already is in every other sense: the shell without a gateway is a blank
  window.
- **Nothing.** Rebuild from source, or re-download. Honest for a spike,
  indefensible for anything an operator installs and forgets, because a shell
  that never updates is pinned against a gateway that does.

The third is the one that fits this product. It is not built here.

## Signing, notarisation, and what it costs

Distributing outside the Mac App Store requires **Apple Developer Program
enrolment at USD 99 per year**, and every build must be signed with a Developer
ID Application certificate and **notarised** — uploaded to Apple, scanned, and
stapled. Without it, macOS Gatekeeper refuses to open a downloaded app, and the
right-click-Open escape hatch was removed in macOS 15.

None of that was paid or done. The build here is unsigned, which is why it runs
from a local build directory and would not survive a download. Notarisation also
has to live in CI to be sustainable, which means an Apple ID, an app-specific
password and a certificate in the repo's secrets — none of which exist.

Mac App Store distribution would avoid the Gatekeeper problem and add a worse
one: guideline 4.2 disfavours apps that are a remote-URL wrapper, which is
exactly what this is.

## What is deliberately not wired

- **Auto-update**, per the section above. A question to answer, not to build.
- **Signing and notarisation.** Cost documented, not paid.
- **Windows and Linux builds.** macOS only.
- **Any change to gateway auth or CORS**, including the bootstrap grant that
  would remove the one-time pairing step.
- **IPC to the gateway page.** `capabilities/default.json` names no `remote`
  origin, so the page the shell loads gets no Tauri IPC at all and cannot reach
  the window-state or deep-link plugins. Everything native happens in Rust.
- **A shared abstraction with `packages/shell-ios`.** Two shells is not enough
  callers to justify a framework.
- **Devtools off in release.** The `devtools` feature is on so the shell can be
  inspected; a shipped build would drop it.
- **A committed `Cargo.lock`.** An application crate normally pins its
  dependency graph. This one is gitignored instead: it is 4,600 machine-written
  lines against a repo that caps a reviewable file at 300, and nothing in CI
  compiles this crate, so there is no build for it to make reproducible. Two
  people building the shell a month apart can resolve different patch versions
  within the ranges in `Cargo.toml`. Commit it the day a release pipeline
  compiles this crate, and record the size exemption then.

## What CI does with this package

Nothing native. `build`, `typecheck`, `lint` and `test` are pure TypeScript and
run on the Linux and Windows runners like any other package — no turbo task
invokes `cargo` or `tauri`. Rust is reachable only through `desktop:dev` and
`desktop:build`, which CI never runs.

## Verdict: defer

The engineering is done and it is cheap. Roughly 250 lines of Rust and a config
generator buy a real window, a real icon, a real menu bar, restored geometry and
working deep links, and the package costs CI nothing because CI never compiles
it. On the quality-per-effort question the Todo asked, the answer is yes:
removing browser chrome does most of the work, and the rest came nearly free.

What is not done is everything between "it runs here" and "someone else can
install it": USD 99 a year, a notarisation step in CI, an update channel, and a
first-run pairing step that today needs a terminal. That is release
infrastructure, not shell work, and it is the whole remaining cost.

So: **defer, and keep the package.** Adopt it when there is a signed release
pipeline to hang it on — at which point the CLI-delivered update path above is
about a day of work. Do not adopt it before then, because an unsigned app that
cannot update is worse for an operator than the browser tab it replaces. Do not
drop it either: the spike's value is that this decision never has to be
re-derived, and the one open question — the refresh-rate cap — needs nothing but
a ProMotion display and one command.
