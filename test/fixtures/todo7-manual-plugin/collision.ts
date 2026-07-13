import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

// biome-ignore lint/style/noDefaultExport: OMP extension factories require a default export.
export default function collidingSurface(api: ExtensionAPI): void {
  api.registerCommand("ulw", { handler: async () => undefined })
}
