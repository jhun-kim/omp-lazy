import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

const MANIFEST_DIRECTORY_ENTRIES = ["src", "skills", "agents", "third_party"] as const
const AUTO_PACKED_ASSETS = ["package.json"] as const

export class PackageGuardError extends Error {
  override readonly name = "PackageGuardError"
}

export type DeclaredManifestAssets = {
  readonly directories: readonly string[]
  readonly explicitFiles: readonly string[]
}

type CandidateRoot = {
  readonly display: string
  readonly real: string
}

function canonicalComparisonPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isContainedPath(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalComparisonPath(root)
  const canonicalCandidate = canonicalComparisonPath(candidate)
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}/`)
}

function normalizeDeclaredPath(root: string, rawPath: string, label: string): string {
  if (rawPath.trim() === "" || isAbsolute(rawPath)) {
    throw new PackageGuardError(`${label} uses traversal or absolute path: ${rawPath}`)
  }
  const resolved = resolve(root, rawPath)
  const relativePath = relative(root, resolved)
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new PackageGuardError(`${label} uses traversal or absolute path: ${rawPath}`)
  }
  return relativePath.replaceAll("\\", "/")
}

function normalizePackedAsset(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "")
  const segments = normalized.split("/")
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PackageGuardError(`invalid packed asset path: ${path}`)
  }
  return normalized
}

async function candidateRoot(root: string): Promise<CandidateRoot> {
  return { display: root, real: await realpath(root) }
}

async function assertContainedRealPath(root: CandidateRoot, path: string): Promise<void> {
  const candidateReal = await realpath(join(root.display, path))
  if (!isContainedPath(root.real, candidateReal)) {
    throw new PackageGuardError(`declared asset escapes candidate root: ${path}`)
  }
}

async function requireManifestFile(
  root: CandidateRoot,
  path: string,
  label: string,
): Promise<void> {
  try {
    const stat = await lstat(join(root.display, path))
    if (stat.isSymbolicLink()) throw new PackageGuardError(`${label} is a symlink: ${path}`)
    if (!stat.isFile()) throw new PackageGuardError(`${label} must be a file: ${path}`)
    await assertContainedRealPath(root, path)
  } catch (error) {
    if (error instanceof PackageGuardError) throw error
    if (error instanceof Error) {
      throw new PackageGuardError(`missing ${label}: ${path}`, { cause: error })
    }
    throw error
  }
}

async function requireManifestDirectory(root: CandidateRoot, path: string): Promise<void> {
  try {
    const stat = await lstat(join(root.display, path))
    if (stat.isSymbolicLink()) {
      throw new PackageGuardError(`manifest directory is a symlink: ${path}`)
    }
    if (!stat.isDirectory()) {
      throw new PackageGuardError(`manifest directory must be a directory: ${path}`)
    }
    await assertContainedRealPath(root, path)
  } catch (error) {
    if (error instanceof PackageGuardError) throw error
    if (error instanceof Error) {
      throw new PackageGuardError(`missing manifest directory: ${path}`, { cause: error })
    }
    throw error
  }
}

async function requirePackedFile(root: CandidateRoot, path: string): Promise<void> {
  if (path === "package.json") return
  try {
    const stat = await lstat(join(root.display, path))
    if (stat.isSymbolicLink()) throw new PackageGuardError(`packed asset is a symlink: ${path}`)
    if (!stat.isFile()) throw new PackageGuardError(`packed asset must be a file: ${path}`)
    await assertContainedRealPath(root, path)
  } catch (error) {
    if (error instanceof PackageGuardError) throw error
    if (error instanceof Error) {
      throw new PackageGuardError(`missing packed asset: ${path}`, { cause: error })
    }
    throw error
  }
}

function isManifestDirectoryEntry(path: string): boolean {
  return MANIFEST_DIRECTORY_ENTRIES.some((entry) => entry === path)
}

export async function declaredManifestAssets(
  root: string,
  files: readonly string[],
): Promise<DeclaredManifestAssets> {
  const candidate = await candidateRoot(root)
  const directories: string[] = []
  const explicitFiles: string[] = []
  for (const rawPath of files) {
    const path = normalizeDeclaredPath(root, rawPath, "manifest file")
    if (isManifestDirectoryEntry(path)) {
      await requireManifestDirectory(candidate, path)
      directories.push(path)
    } else {
      await requireManifestFile(candidate, path, "manifest file")
      explicitFiles.push(path)
    }
  }
  return { directories, explicitFiles }
}

export async function declaredManifestExtensions(
  root: string,
  extensions: readonly string[],
): Promise<readonly string[]> {
  const candidate = await candidateRoot(root)
  const paths: string[] = []
  for (const rawPath of extensions) {
    const path = normalizeDeclaredPath(root, rawPath, "manifest extension")
    await requireManifestFile(candidate, path, "manifest extension")
    paths.push(path)
  }
  return paths
}

export function requireReviewedExtensionBoundary(extensions: readonly string[]): void {
  if (extensions.length !== 1 || extensions[0] !== "src/index.ts") {
    throw new PackageGuardError(`unexpected manifest extension: ${extensions.join(", ")}`)
  }
}

function isPackedAssetDeclared(
  path: string,
  directories: readonly string[],
  explicitFiles: readonly string[],
): boolean {
  return (
    AUTO_PACKED_ASSETS.some((asset) => asset === path) ||
    explicitFiles.some((asset) => asset === path) ||
    directories.some((directory) => path.startsWith(`${directory}/`))
  )
}

export async function verifyPackedAssetCoverage(options: {
  readonly root: string
  readonly extensions: readonly string[]
  readonly directories: readonly string[]
  readonly explicitFiles: readonly string[]
  readonly packedAssets: readonly string[]
}): Promise<readonly string[]> {
  const root = await candidateRoot(options.root)
  const packedAssets = [...new Set(options.packedAssets.map(normalizePackedAsset))]
  const packedAssetSet = new Set(packedAssets)
  for (const asset of packedAssets) {
    await requirePackedFile(root, asset)
    if (!isPackedAssetDeclared(asset, options.directories, options.explicitFiles)) {
      throw new PackageGuardError(`unlisted packed asset: ${asset}`)
    }
  }
  for (const extension of options.extensions) {
    if (!packedAssetSet.has(extension)) {
      throw new PackageGuardError(`manifest extension is not packed: ${extension}`)
    }
  }
  for (const file of options.explicitFiles) {
    if (!packedAssetSet.has(file)) {
      throw new PackageGuardError(`manifest file is not packed: ${file}`)
    }
  }
  return packedAssets
}
