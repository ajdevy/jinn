/**
 * Which Jinn this page is, so the orb never has to guess.
 *
 * Several instances run side by side on one machine and they all look alike in
 * a browser tab. The gateway names itself in the auth state the app already
 * fetches on boot; the port is the one the browser actually reached it on,
 * which is the number the operator would read off their own address bar.
 */
import { lastKnownInstance } from "@/lib/auth"

export interface InstanceIdentity {
  /** The gateway's own instance name, or the host it is served from when it has
   *  not named itself yet. */
  name: string
  port: string
}

export function describeInstance(): InstanceIdentity {
  const here = typeof window === "undefined" ? null : window.location
  const port = here?.port || (here?.protocol === "https:" ? "443" : "80")
  return { name: lastKnownInstance() ?? here?.hostname ?? "unknown", port }
}
