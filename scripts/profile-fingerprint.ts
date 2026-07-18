import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join, relative } from "node:path"

export async function profileFingerprint(root: string): Promise<string> {
  try {
    await lstat(root)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "ABSENT"
    throw error
  }

  const hasher = new Bun.CryptoHasher("sha256")
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path)
    const key = relative(root, path).replaceAll("\\", "/") || "."
    if (metadata.isSymbolicLink()) {
      hasher.update(`link:${key}:${await readlink(path)}\n`)
      return
    }
    if (metadata.isDirectory()) {
      hasher.update(`directory:${key}\n`)
      const entries = await readdir(path)
      for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        await visit(join(path, entry))
      }
      return
    }
    if (metadata.isFile()) {
      hasher.update(`file:${key}:`)
      hasher.update(await readFile(path))
      hasher.update("\n")
    }
  }

  await visit(root)
  return hasher.digest("hex")
}
