import { access, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import {
  declaredManifestAssets,
  declaredManifestExtensions,
  PackageGuardError,
  requireReviewedExtensionBoundary,
  verifyPackedAssetCoverage,
} from "./package-asset-paths"

const EXPECTED_SOURCE_COMMITS = {
  lazycodex: "f39306f1adab6ff155fd736cc7376d27156472bc",
  omp: "d0f90f35ae0f4aba48430b51a7203013dc0c5ff3",
} as const

const REQUIRED_ASSETS = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "scripts/assert-skill-sync.ts",
  "third_party/SOURCE_COMMITS.json",
  "third_party/lazycodex/LICENSE",
  "third_party/lazycodex/SOURCE.md",
  "third_party/omp/SOURCE.md",
] as const

const forbiddenRuntimePatterns = [
  /\bCODEX_HOME\b/,
  /(?:^|[\\/])\.codex(?:[\\/]|$)/,
  /\bcodex:/,
  /lazycodex-sources/i,
  /(?:from\s+|import\s*\()["'][^"']*(?:codex|lazycodex)/i,
  /(?:collaboration|functions)\.(?:spawn_agent|send_message|followup_task)/,
  /[A-Za-z]:\\Users\\/,
  /(?:^|["'`])\/(?:Users|home)\//,
] as const

const manifestSchema = z
  .object({
    dependencies: z.object({ zod: z.string().optional() }).catchall(z.string()).optional(),
    files: z.array(z.string()),
    omp: z.object({ extensions: z.array(z.string().min(1)).min(1) }),
  })
  .passthrough()

const sourceCommitsSchema = z.object({
  lazycodex: z.literal(EXPECTED_SOURCE_COMMITS.lazycodex),
  omp: z.literal(EXPECTED_SOURCE_COMMITS.omp),
})

export type CandidateInspection = {
  readonly forbiddenAssets: readonly string[]
  readonly packedAssets: readonly string[]
  readonly requiredAssets: readonly string[]
  readonly sourceCommits: typeof EXPECTED_SOURCE_COMMITS
}

export { PackageGuardError }

async function requireFiles(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await access(join(root, path))
    } catch (error) {
      if (error instanceof Error) {
        throw new PackageGuardError(`missing required asset: ${path}`, { cause: error })
      }
      throw error
    }
  }
}

async function scanRuntimeFiles(root: string): Promise<void> {
  const glob = new Bun.Glob("{src,skills,agents}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,md}")
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    const content = await readFile(join(root, path), "utf8")
    if (forbiddenRuntimePatterns.some((pattern) => pattern.test(content))) {
      throw new PackageGuardError(`forbidden runtime reference: ${path}`)
    }
  }
}

async function verifyMarkdownReferences(root: string): Promise<void> {
  const glob = new Bun.Glob("{README.md,skills/**/*.md,agents/**/*.md}")
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    const content = await readFile(join(root, path), "utf8")
    for (const match of content.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
      const rawTarget = match[1]
      if (rawTarget === undefined) continue
      const target = resolve(root, dirname(path), decodeURIComponent(rawTarget.split("#")[0] ?? ""))
      const fromRoot = relative(root, target)
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new PackageGuardError(`escaping Markdown reference: ${path} -> ${rawTarget}`)
      }
      try {
        await access(target)
      } catch (error) {
        if (error instanceof Error) {
          throw new PackageGuardError(`missing Markdown reference: ${path} -> ${rawTarget}`, {
            cause: error,
          })
        }
        throw error
      }
    }
  }
}

function forbiddenPackedAssets(paths: readonly string[]): readonly string[] {
  return paths.filter((path) =>
    /(^|\/)(?:\.omo|\.codex|node_modules|test|coverage|dist|cache)(?:\/|$)|(^|\/)\.env|\.log$|\.tgz$/i.test(
      path,
    ),
  )
}

export async function inspectCandidate(
  root: string,
  packedAssets: readonly string[],
): Promise<CandidateInspection> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  )
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
  if (manifest.dependencies?.zod !== "4.4.3") {
    throw new PackageGuardError("missing runtime dependency: zod")
  }
  const forbiddenDependency = runtimeDependencies.find(
    (name) => name === "@oh-my-pi/pi-coding-agent" || /codex|lazycodex/i.test(name),
  )
  if (forbiddenDependency !== undefined) {
    throw new PackageGuardError(`forbidden runtime dependency: ${forbiddenDependency}`)
  }
  if (!manifest.files.includes("scripts/assert-skill-sync.ts")) {
    throw new PackageGuardError("package files must include scripts/assert-skill-sync.ts")
  }
  const declaredExtensions = await declaredManifestExtensions(root, manifest.omp.extensions)
  requireReviewedExtensionBoundary(declaredExtensions)
  const declaredAssets = await declaredManifestAssets(root, manifest.files)

  await requireFiles(root, REQUIRED_ASSETS)
  const sourceCommits = sourceCommitsSchema.parse(
    JSON.parse(await readFile(join(root, "third_party", "SOURCE_COMMITS.json"), "utf8")),
  )
  await scanRuntimeFiles(root)
  await verifyMarkdownReferences(root)

  const normalizedPackedAssets = await verifyPackedAssetCoverage({
    root,
    extensions: declaredExtensions,
    directories: declaredAssets.directories,
    explicitFiles: declaredAssets.explicitFiles,
    packedAssets,
  })
  const forbiddenAssets = forbiddenPackedAssets(normalizedPackedAssets)
  if (forbiddenAssets.length > 0) {
    throw new PackageGuardError(`forbidden packed assets: ${forbiddenAssets.join(", ")}`)
  }
  const missingPackedAsset = REQUIRED_ASSETS.find((path) => !normalizedPackedAssets.includes(path))
  if (missingPackedAsset !== undefined) {
    throw new PackageGuardError(`required asset is not packed: ${missingPackedAsset}`)
  }

  const researchSkill = join(root, "skills", "ulw-research", "SKILL.md")
  if (await Bun.file(researchSkill).exists()) {
    await requireFiles(root, ["skills/ulw-research/ATTRIBUTION.md"])
  }

  return {
    forbiddenAssets,
    packedAssets: normalizedPackedAssets,
    requiredAssets: REQUIRED_ASSETS,
    sourceCommits,
  }
}
