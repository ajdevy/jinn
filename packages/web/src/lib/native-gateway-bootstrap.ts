import { installGatewayTransport } from "./gateway-transport"
import { createNativeGatewayTransport, pairNativeGateway } from "./native-gateway-transport"
import { nativeBridge } from "@/platform/native-bridge"

const ACTIVE_ORIGIN_KEY = "jinn.native.active-origin"

export function savedNativeGatewayOrigin(): string | undefined {
  if (!nativeBridge() || typeof localStorage === "undefined") return undefined
  return localStorage.getItem(ACTIVE_ORIGIN_KEY) ?? undefined
}

export function installSavedNativeGateway(): string | undefined {
  const bridge = nativeBridge()
  const origin = savedNativeGatewayOrigin()
  if (!bridge || !origin) return undefined
  try {
    installGatewayTransport(createNativeGatewayTransport(origin, bridge))
    return origin
  } catch {
    localStorage.removeItem(ACTIVE_ORIGIN_KEY)
    return undefined
  }
}

export async function pairAndInstallNativeGateway(origin: string, code: string): Promise<string> {
  const bridge = nativeBridge()
  if (!bridge) throw new Error("The native gateway bridge is unavailable")
  const receipt = await pairNativeGateway(origin, code, bridge)
  localStorage.setItem(ACTIVE_ORIGIN_KEY, receipt.origin)
  installGatewayTransport(createNativeGatewayTransport(receipt.origin, bridge))
  return receipt.origin
}
