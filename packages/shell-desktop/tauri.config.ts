import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The shell loads the operator's own gateway over the network instead of
 * bundling the web build.
 *
 * That is not a shortcut, it is what the existing code requires. The web app
 * derives its API base from `window.location.origin`, opens its event socket
 * same-origin, authenticates with `HttpOnly` cookies, and talks to a gateway
 * whose CORS check accepts only `http(s)` origins. Serving the bundle from
 * Tauri's custom protocol breaks all four on macOS, where the origin is
 * `tauri://localhost` and the gateway 403s every `/api` call on the scheme
 * alone; on Windows the origin is `http://tauri.localhost`, which clears CORS
 * but is still cross-site, so the `SameSite=Lax` session cookies are never
 * sent. Loading the gateway's own origin keeps all four true on both, and needs
 * no change to auth or to the gateway.
 *
 * The cost of the choice is real and belongs in the spike's verdict rather than
 * in a comment: the app is inert whenever the operator's gateway is
 * unreachable. See README.md.
 */

/**
 * Every gateway lives at a different address, so the window's URL is read at
 * sync time and never committed. Its absence is fatal on purpose: a shell
 * silently pointed at the wrong origin looks identical to one that works until
 * it does not.
 */
export const GATEWAY_URL_VAR = "JINN_SHELL_SERVER_URL"

const EXAMPLE = `${GATEWAY_URL_VAR}=http://192.0.2.10:7778 pnpm --filter @jinn/shell-desktop desktop:dev`

/** The generated overlay, merged over `src-tauri/tauri.conf.json` by the Tauri CLI. */
export interface ConfigOverlay {
  app: {
    windows: [
      {
        label: string
        title: string
        url: string
        width: number
        height: number
        minWidth: number
        minHeight: number
      },
    ]
  }
}

/**
 * The gateway URL the window opens, normalised. Throws rather than returning a
 * fallback: every failure here is a misconfiguration the operator can fix, and
 * the message says which variable and what a good value looks like.
 */
export function resolveServerUrl(env: NodeJS.ProcessEnv): string {
  const raw = env[GATEWAY_URL_VAR]?.trim()

  if (!raw) {
    throw new Error(
      `${GATEWAY_URL_VAR} is unset, so there is no gateway for the shell to load. ` +
        `Set it to the gateway's address and re-run, e.g. ${EXAMPLE}`,
    )
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(
      `${GATEWAY_URL_VAR} is "${raw}", which is not a URL. It needs a scheme, e.g. ${EXAMPLE}`,
    )
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${GATEWAY_URL_VAR} is "${raw}", whose scheme is not http or https. The web app derives its ` +
        `API base from the window's origin and presents cookies to it, and the gateway's CORS ` +
        `check accepts no other scheme, e.g. ${EXAMPLE}`,
    )
  }

  return url.toString()
}

/**
 * The whole window, not just its URL: the Tauri CLI replaces arrays wholesale
 * when it merges an overlay, so a partial window here would drop the rest.
 * `src-tauri/tauri.conf.json` therefore ships no window at all, and `main.rs`
 * refuses to start without one.
 */
export function buildConfigOverlay(serverUrl: string): ConfigOverlay {
  return {
    app: {
      windows: [
        {
          label: "main",
          title: "Jinn",
          url: serverUrl,
          width: 1280,
          height: 860,
          // The web app's mobile layout starts at 390px wide; below that it has
          // no design, so the window does not go there.
          minWidth: 390,
          minHeight: 480,
        },
      ],
    },
  }
}

const OVERLAY_FILE = "tauri.conf.gen.json"

function sync(): void {
  const overlay = buildConfigOverlay(resolveServerUrl(process.env))
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "src-tauri", OVERLAY_FILE)
  writeFileSync(target, `${JSON.stringify(overlay, null, 2)}\n`)
  process.stdout.write(`${OVERLAY_FILE}: ${overlay.app.windows[0].url}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync()
}
