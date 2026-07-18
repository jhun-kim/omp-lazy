import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { registerOmpLazyExtension } from "./extension/register-extension"

export function ompLazy(api: ExtensionAPI): void {
  registerOmpLazyExtension(api)
}

export { ompLazy as default }
