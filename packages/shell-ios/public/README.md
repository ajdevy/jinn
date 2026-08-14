# Not the app

The shell loads the gateway's own origin at runtime (`server.url` in
`capacitor.config.ts`), so nothing here is ever served. Capacitor's CLI still
requires `webDir` to exist, and this file is what keeps the directory in git.
