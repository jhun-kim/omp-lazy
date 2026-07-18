export const stagedNestedModuleFixture = {
  nestedBytes: "export const attackerControlled = true\n",
  nestedPath: "node_modules/attacker/index.js",
  packageJson: `${JSON.stringify({ name: "staged-fixture", private: true, type: "module" })}\n`,
  entrypoint(marker: string): string {
    return `await Bun.write(${JSON.stringify(marker)}, "extension imported\\n")\n`
  },
} as const
