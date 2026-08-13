# @jinn/shell-ios

A Capacitor shell that runs the existing web dashboard as a native iOS app. It
is a **spike**: enough to install, measure and judge, not a shipped app.

## Status

Undecided, pending a measurement that needs hardware. See the verdict on the
Todo that produced this package. What is known:

- The shell builds. Its Swift package graph resolves and the project compiles up
  to the signing step.
- It cannot be installed from this repo's CI or from a machine without an Apple
  Developer account. `xcodebuild` stops with
  `Signing for "App" requires a development team`.
- No frame measurement has been taken yet, so the claim that a Capacitor WebView
  scrolls worse than the same build installed as a PWA is neither confirmed nor
  refuted here. `scripts/frame-probe.js` is the instrument; see below.

## How it loads the app

The shell does **not** bundle the web build. It points a WKWebView at the
operator's own running gateway (`server.url` in `capacitor.config.ts`).

That is forced by the existing code rather than chosen for convenience. The web
app derives its API base from `window.location.origin`, opens its plugin socket
same-origin, authenticates with `HttpOnly` cookies, and talks to a gateway whose
CORS check rejects any non-`http(s)` origin. Serving the bundle from
`capacitor://localhost` breaks all four at once. Loading the gateway's origin
keeps every one of them true and needs no change to auth or to the gateway.

Two consequences, both real:

- The app is inert whenever the gateway is unreachable.
- App Store review guideline 4.2 disfavours apps that are a remote-URL wrapper.

## Prerequisites

- macOS with Xcode and an iOS SDK.
- An Apple Developer account, for anything beyond the Simulator.
- A gateway reachable from the phone — the same Wi-Fi, on its LAN address.

## Running it

```sh
# 1. Point the shell at your gateway. Its LAN address, not localhost:
#    the phone resolves this, not your Mac.
export JINN_SHELL_SERVER_URL=http://192.168.x.x:<your gateway port>

# 2. Generate the native config from it.
pnpm --filter @jinn/shell-ios ios:sync

# 3. Open Xcode.
pnpm --filter @jinn/shell-ios ios:open
```

Then, once per machine, supply signing. `DEVELOPMENT_TEAM` is deliberately empty
in the committed project — a team ID identifies a real Apple account and is not
ours to publish — so provide it locally:

```sh
cp ios/Local.xcconfig.example ios/Local.xcconfig
# edit it, then build the Debug configuration from Xcode
```

`ios/debug.xcconfig` includes `Local.xcconfig` optionally, so the project still
opens without it and fails at signing with Xcode's own message.

## Measuring it

`scripts/frame-probe.js` is the go/no-go instrument. Run it **unmodified** in
both the installed PWA and this shell, against the same gateway, the same build
and the same device — the WebView must be the only variable.

1. Open the chat surface with a long transcript.
2. Attach Safari Web Inspector to the device.
3. Paste the whole file into the console.
4. Copy the single JSON line it prints.

It drives a fixed scroll over a fixed duration and reports p50/p95/max frame
interval, dropped frames against a 60Hz baseline, and the actual duration. It
refuses to run rather than produce an incomparable number if the transcript is
too short.

## What is wired, and what is not

Wired: haptics and keyboard avoidance, through a facade in
`packages/web/src/lib/native/` that reads the bridge globals Capacitor injects.
The web bundle gains no `@capacitor/*` dependency — it has roughly 7 KB of gzip
headroom on its initial-critical-path budget, and a native package the browser
build can never execute is not what that headroom is for. Off-shell every call
is a no-op, so one bundle still serves the browser, the PWA and the shell.

Not wired: push notifications. The plugin is installed and will register, but
there is no APNs key, no push capability on the app ID, and no sender. That is
provisioning work the spike deliberately left out.

Not present, and deliberately: the community plugin that lifts WKWebView's 60Hz
`requestAnimationFrame` cap. It works through WebKit private API, which is not
App Store safe. It is named in the research note behind this spike so nobody has
to rediscover it; it must not enter this tree.

## What CI does with this package

Nothing native. `build`, `typecheck`, `lint` and `test` are pure TypeScript and
run on the Linux and Windows runners like any other package. Xcode is reachable
only through `ios:sync` and `ios:open`, which CI never invokes.
