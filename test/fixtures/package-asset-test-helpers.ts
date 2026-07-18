import { expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { removeCandidate, repositoryRoot, run } from "./package-test-helpers"

const manifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    files: z.array(z.string()),
    omp: z.object({ extensions: z.array(z.string()) }),
  })
  .passthrough()

const receiptSchema = z
  .object({
    forbiddenAssets: z.array(z.string()),
    mode: z.string(),
    packedAssets: z.array(z.string()),
    requiredAssets: z.array(z.string()),
    sha256: z.string().nullable(),
    tarball: z.string().nullable(),
  })
  .passthrough()

export type PackageManifest = z.infer<typeof manifestSchema>

export type PackageAssetTestContext = {
  readonly candidates: string[]
  readonly temporaryRoots: string[]
  readonly cleanup: () => Promise<void>
}

export function packageAssetTestContext(): PackageAssetTestContext {
  const candidates: string[] = []
  const temporaryRoots: string[] = []
  return {
    candidates,
    temporaryRoots,
    cleanup: async () => {
      await Promise.all([...candidates.splice(0), ...temporaryRoots.splice(0)].map(removeCandidate))
    },
  }
}

export function inspectCommand(candidate: string): readonly string[] {
  return ["bun", "scripts/pack-candidate.ts", "--candidate", candidate, "--mode", "inspect"]
}

export function inspect(candidate: string) {
  return run(inspectCommand(candidate))
}

export function parseReceipt(stdout: string) {
  return receiptSchema.parse(JSON.parse(stdout))
}

export async function readManifest(candidate: string): Promise<PackageManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(join(candidate, "package.json"), "utf8")))
}

export async function packedAssetsFor(candidate: string): Promise<readonly string[]> {
  const result = inspect(candidate)
  expect(result.exitCode).toBe(0)
  return parseReceipt(result.stdout).packedAssets
}

export async function expectedRuntimeAssets(): Promise<readonly string[]> {
  const assets = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "scripts/assert-skill-sync.ts"]
  const glob = new Bun.Glob("{src,skills,agents,third_party}/**/*")
  for await (const path of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    assets.push(path.replaceAll("\\", "/"))
  }
  return assets
}
