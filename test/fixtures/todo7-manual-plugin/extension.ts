import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import {
  ActivationProvenanceController,
  registerTrustedActivation,
} from "../../../src/activation/provenance-controller"
import { registerWorkflowCommands } from "../../../src/commands/register-workflow-commands"

// biome-ignore lint/style/noDefaultExport: OMP extension factories require a default export.
export default function todo7ManualSurface(api: ExtensionAPI): void {
  const controller = new ActivationProvenanceController({ isActive: async () => false })
  registerWorkflowCommands(api, { execute: async () => undefined })
  registerTrustedActivation(api, controller)
}
