# Almost empty, deliberately

The shell loads the operator's gateway over the network, so it bundles no web
assets — see the package README. The Tauri CLI still requires
`build.frontendDist` to name a directory that exists, and this is it.

`probe.html` is the one exception: a blank local page for
`scripts/refresh-rate-probe.js` to run in, so the measurement is not taken
through the gateway's own rendering. It is never shown unless
`JINN_SHELL_PROBE` is set.
