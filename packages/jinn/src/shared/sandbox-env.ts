import os from "node:os";
import path from "node:path";
import { resolveHomeIdentity, resolveJinnHome } from "./home.js";

/**
 * The variables that name WHICH Jinn instance a process belongs to: its home, its
 * binding, and the credentials of the gateway session that launched it. A process
 * pointed at a different instance must inherit none of them — read against another
 * home they route the work straight back to the instance they came from.
 */
export const JINN_INSTANCE_IDENTITY_ENV_KEYS = [
  "JINN_HOME",
  "JINN_HOME_IDENTITY",
  "JINN_INSTANCE",
  "JINN_HOST",
  "JINN_PORT",
  "JINN_GATEWAY_URL",
  "JINN_GATEWAY_TOKEN",
  "JINN_SESSION_ID",
  "JINN_SESSION_CAPABILITY",
  "JINN_TAKE_PORT",
] as const;

/** Ports a live gateway owns: the default instance, and the demo instance beside it. */
export const PRODUCTION_GATEWAY_PORTS: readonly number[] = [7777, 7788]; // footgun: ok this list is the refusal set itself — naming the live ports is what it is for

export interface JinnInstanceTarget {
  home: string;
  instance?: string;
  host?: string;
  port?: number;
  gatewayUrl?: string;
  token?: string;
}

/**
 * The environment for a child that belongs to `target`. Everything unrelated is
 * inherited; every instance-identity variable is dropped and then re-set from the
 * target alone, so nothing the parent instance owns reaches the child.
 */
export function buildSandboxChildEnv(
  target: JinnInstanceTarget,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const identity: ReadonlySet<string> = new Set(JINN_INSTANCE_IDENTITY_ENV_KEYS);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (identity.has(key) || value === undefined) continue;
    env[key] = value;
  }
  env.JINN_HOME = path.resolve(target.home);
  if (target.instance) env.JINN_INSTANCE = target.instance;
  if (target.host) env.JINN_HOST = target.host;
  if (target.port !== undefined) env.JINN_PORT = String(target.port);
  if (target.gatewayUrl) env.JINN_GATEWAY_URL = target.gatewayUrl;
  if (target.token) env.JINN_GATEWAY_TOKEN = target.token;
  return env;
}

/**
 * Point this process at `target` in place, before any module resolves paths from the
 * environment. Identity inherited from a DIFFERENT instance is dropped: a leaked
 * JINN_PORT from the enclosing gateway session otherwise outranks the target home's
 * own config.yaml, which is how a sandbox `jinn pair` reached the live gateway.
 *
 * A target that is already this process's own instance keeps its binding, so the
 * JINN_HOST/JINN_PORT a container publishes still describe the home they name.
 */
export function retargetInstanceEnv(
  target: Pick<JinnInstanceTarget, "home" | "instance">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const home = path.resolve(target.home);
  if (resolveHomeIdentity(resolveJinnHome(env)) !== resolveHomeIdentity(home)) {
    for (const key of JINN_INSTANCE_IDENTITY_ENV_KEYS) delete env[key];
  }
  env.JINN_HOME = home;
  if (target.instance) env.JINN_INSTANCE = target.instance;
}

/**
 * Refuse a target that would drive a live gateway. Sandboxes exist so that a wrong
 * guess costs a temp directory rather than the operator's instance, and the two
 * values that decide which one is being driven are the home and the port.
 */
export function assertNotProductionGateway(target: { home?: string; port?: number }): void {
  if (target.port !== undefined && PRODUCTION_GATEWAY_PORTS.includes(target.port)) {
    throw new Error(
      `Refusing to use port ${target.port}: a live gateway owns it. ` +
      `Sandbox work needs a throwaway port (7800 and up).`,
    );
  }
  if (target.home === undefined) return;
  const home = path.resolve(target.home);
  if (resolveHomeIdentity(home) === resolveHomeIdentity(defaultInstanceHome())) {
    throw new Error(
      `Refusing to use ${home}: it is the default instance home. ` +
      `Point JINN_HOME at a throwaway directory for sandbox work.`,
    );
  }
}

function defaultInstanceHome(): string {
  // Deliberately not resolveJinnHome(): a sandbox sets JINN_HOME, so honouring it would
  // make the sandbox "production" and wave the real home through.
  return path.join(os.homedir(), ".jinn"); // footgun: ok the canary must know the default home even when JINN_HOME names another
}
