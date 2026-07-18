import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

export class StagedSourceVerificationError extends Error {
  override readonly name = "StagedSourceVerificationError"
}

type VerificationRequest = {
  readonly installedRoot: string
  readonly packedAssets: readonly string[]
  readonly sourceCommit: string
  readonly sourceRoot: string
}

function normalizeAsset(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "")
  const segments = normalized.split("/")
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new StagedSourceVerificationError(`invalid staged asset path: ${path}`)
  }
  return normalized
}

async function gitTree(root: string, commit: string): Promise<ReadonlyMap<string, string>> {
  const child = Bun.spawn(["git", "-C", root, "ls-tree", "-r", "-z", "--full-tree", commit], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new StagedSourceVerificationError(`committed source listing failed: ${stderr}`)
  }
  const tree = new Map<string, string>()
  for (const entry of stdout.split("\0")) {
    if (entry.length === 0) continue
    const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(entry)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new StagedSourceVerificationError("committed source listing was malformed")
    }
    tree.set(match[2], match[1])
  }
  return tree
}

async function installedFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = normalizeAsset(
        directory.length === 0 ? entry.name : `${directory}/${entry.name}`,
      )
      if (entry.name === "node_modules") {
        throw new StagedSourceVerificationError(
          "staged package contains package-local node_modules",
        )
      }
      if (entry.isSymbolicLink()) {
        throw new StagedSourceVerificationError(`staged package contains a symlink: ${path}`)
      }
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else
        throw new StagedSourceVerificationError(`staged package contains a special file: ${path}`)
    }
  }
  await visit("")
  return files.toSorted()
}

function gitBlobHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex")
}

export async function verifyInstalledPackage(request: VerificationRequest): Promise<void> {
  const packedAssets = request.packedAssets.map(normalizeAsset).toSorted()
  if (new Set(packedAssets).size !== packedAssets.length) {
    throw new StagedSourceVerificationError("staged package receipt contains duplicate assets")
  }
  const files = await installedFiles(request.installedRoot)
  if (JSON.stringify(files) !== JSON.stringify(packedAssets)) {
    throw new StagedSourceVerificationError("installed package files differ from packed assets")
  }
  const tree = await gitTree(request.sourceRoot, request.sourceCommit)
  for (const path of files) {
    const sourceHash = tree.get(path)
    if (sourceHash === undefined) {
      throw new StagedSourceVerificationError(`installed package file is not committed: ${path}`)
    }
    const candidate = resolve(request.installedRoot, path)
    const fromRoot = relative(request.installedRoot, candidate)
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new StagedSourceVerificationError(`installed package file escaped root: ${path}`)
    }
    if (gitBlobHash(await readFile(join(request.installedRoot, path))) !== sourceHash) {
      throw new StagedSourceVerificationError(`installed package file differs from source: ${path}`)
    }
  }
}
