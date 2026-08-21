import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JINN_INSTANCE_IDENTITY_ENV_KEYS,
  PRODUCTION_GATEWAY_PORTS,
  assertNotProductionGateway,
  buildSandboxChildEnv,
  retargetInstanceEnv,
} from "../sandbox-env.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-env-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A fabricated home directory, so "the default instance home" is a path under the temp
// root rather than the one this machine actually runs.
const defaultInstanceHome = path.join(scratch, "home", ".jinn");
beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(path.join(scratch, "home"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything a CLI inherits when it is launched from inside a live gateway session. */
function liveSessionEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    JINN_HOME: defaultInstanceHome,
    JINN_HOME_IDENTITY: defaultInstanceHome,
    JINN_INSTANCE: "jinn",
    JINN_HOST: "0.0.0.0",
    JINN_PORT: "7801",
    JINN_GATEWAY_URL: "http://127.0.0.1:7801",
    JINN_GATEWAY_TOKEN: "live-gateway-token",
    JINN_SESSION_ID: "live-session",
    JINN_SESSION_CAPABILITY: "live-capability",
    JINN_TAKE_PORT: "1",
  };
}

describe("buildSandboxChildEnv", () => {
  it("carries no live instance identity into a throwaway child", () => {
    const home = path.join(scratch, "throwaway");

    const env = buildSandboxChildEnv({ home, port: 7899 }, liveSessionEnv());

    const survivors = JINN_INSTANCE_IDENTITY_ENV_KEYS
      .map((key) => ({ key, value: env[key] }))
      .filter(({ key, value }) => {
        if (value === undefined) return false;
        if (key === "JINN_HOME") return value !== home;
        if (key === "JINN_PORT") return value !== "7899";
        return true;
      });

    expect(survivors).toEqual([]);
  });

  it("passes unrelated variables through untouched", () => {
    const env = buildSandboxChildEnv({ home: path.join(scratch, "throwaway") }, liveSessionEnv());

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/agent");
  });

  it("names the target instance the child belongs to", () => {
    const home = path.join(scratch, "atlas");

    const env = buildSandboxChildEnv({
      home,
      instance: "atlas",
      host: "127.0.0.1",
      port: 7899,
      gatewayUrl: "http://127.0.0.1:7899",
      token: "throwaway-token",
    }, liveSessionEnv());

    expect(env).toMatchObject({
      JINN_HOME: home,
      JINN_INSTANCE: "atlas",
      JINN_HOST: "127.0.0.1",
      JINN_PORT: "7899",
      JINN_GATEWAY_URL: "http://127.0.0.1:7899",
      JINN_GATEWAY_TOKEN: "throwaway-token",
    });
  });
});

describe("assertNotProductionGateway", () => {
  it("names the ports a live gateway owns", () => {
    expect(PRODUCTION_GATEWAY_PORTS).toEqual([7777, 7788]); // footgun: ok pins the refusal set, so the cases below cannot pass against an empty list
  });

  it.each(PRODUCTION_GATEWAY_PORTS)("refuses the live gateway port %d", (port) => {
    expect(() => assertNotProductionGateway({ home: path.join(scratch, "throwaway"), port }))
      .toThrow(String(port));
  });

  it("refuses the default instance home", () => {
    expect(() => assertNotProductionGateway({ home: defaultInstanceHome }))
      .toThrow(new RegExp(defaultInstanceHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("allows a throwaway home on a throwaway port", () => {
    expect(() => assertNotProductionGateway({ home: path.join(scratch, "throwaway"), port: 7899 }))
      .not.toThrow();
  });
});

describe("retargetInstanceEnv", () => {
  it("drops the binding and credentials of the instance being left", () => {
    const env = liveSessionEnv();
    const home = path.join(scratch, "sandbox");

    retargetInstanceEnv({ home, instance: "sandbox" }, env);

    expect(env.JINN_HOME).toBe(home);
    expect(env.JINN_INSTANCE).toBe("sandbox");
    expect(env.JINN_PORT).toBeUndefined();
    expect(env.JINN_HOST).toBeUndefined();
    expect(env.JINN_GATEWAY_URL).toBeUndefined();
    expect(env.JINN_GATEWAY_TOKEN).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBeUndefined();
  });

  it("keeps a binding that already describes the target home", () => {
    const home = path.join(scratch, "container-home");
    const env: NodeJS.ProcessEnv = { JINN_HOME: home, JINN_HOST: "0.0.0.0", JINN_PORT: "8080" };

    retargetInstanceEnv({ home, instance: "jinn" }, env);

    expect(env.JINN_HOST).toBe("0.0.0.0");
    expect(env.JINN_PORT).toBe("8080");
  });
});
