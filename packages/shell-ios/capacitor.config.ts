import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The shell loads the operator's own gateway over the network instead of
 * bundling the web build.
 *
 * That is not a shortcut, it is what the existing code requires. The web app
 * derives its API base from `window.location.origin`, opens its plugin socket
 * same-origin, authenticates with HttpOnly cookies, and talks to a gateway
 * whose CORS check rejects any non-http(s) origin. Serving the bundle from
 * `capacitor://localhost` would break all four at once. Loading the gateway's
 * own origin keeps every one of them true and needs no change to auth or to
 * the gateway. Capacitor still injects its native bridge in this mode, so the
 * plugins below work.
 *
 * The cost of the choice is real and belongs in the spike's verdict rather than
 * in a comment: App Store review guideline 4.2 disfavours remote-URL wrappers,
 * and the app is inert whenever the operator's gateway is unreachable.
 */

/**
 * Every gateway lives at a different address, so this is read at `cap sync`
 * time and never committed. Its absence is fatal on purpose: a shell silently
 * pointed at the wrong origin looks identical to one that works until it does
 * not.
 */
const serverUrl = process.env.JINN_SHELL_SERVER_URL;

if (!serverUrl) {
  throw new Error(
    "JINN_SHELL_SERVER_URL is unset, so there is no gateway for the shell to load. " +
      "Set it to the gateway's LAN address and re-run, e.g. " +
      "JINN_SHELL_SERVER_URL=http://192.0.2.10:<port> pnpm --filter @jinn/shell-ios ios:sync",
  );
}

const config: CapacitorConfig = {
  appId: "run.jinn.shell",
  appName: "Jinn",
  // Unused under a remote `server.url`, but the CLI still requires the
  // directory to exist. See public/README.md.
  webDir: "public",
  server: {
    url: serverUrl,
    // A gateway on a LAN address is plain http, which iOS blocks by default.
    cleartext: true,
  },
  plugins: {
    Keyboard: {
      // The web layer owns keyboard geometry through --keyboard-inset, which it
      // derives from visualViewport. Letting the native layer resize the web
      // view as well would apply the inset twice.
      resize: "none",
    },
  },
};

export default config;
