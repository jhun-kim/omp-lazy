import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"

export type PublicExtensionFactory = (api: ExtensionAPI) => void | Promise<void>

export const publicLoader = loadExtensions
