import { createReadStream } from "node:fs"

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of createReadStream(path)) hasher.update(chunk)
  return hasher.digest("hex")
}
