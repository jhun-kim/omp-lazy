import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

describe("package manifest", () => {
  it("declares the pinned OMP extension boundary when the package is loaded", async () => {
    // Given: the package manifest is the distribution trust boundary.
    const raw = await readFile(join(root, "package.json"), "utf8")

    // When: its public OMP metadata is decoded.
    const manifest = JSON.parse(raw)

    // Then: the host stays optional and the source extension entry is exact.
    expect(manifest.omp).toEqual({ extensions: ["./src/index.ts"] })
    expect(manifest.peerDependencies).toEqual({
      "@oh-my-pi/pi-coding-agent": ">=16.4.8 <17",
    })
    expect(manifest.peerDependenciesMeta).toEqual({
      "@oh-my-pi/pi-coding-agent": { optional: true },
    })
    expect(manifest.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("16.4.8")
    expect(manifest.dependencies?.["@oh-my-pi/pi-coding-agent"]).toBeUndefined()
  })

  it("records complete source provenance and required notices", async () => {
    // Given: provenance files are distributable package inputs.
    const notice = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
    const provenance = await readFile(join(root, "third_party", "SOURCE_COMMITS.json"), "utf8")

    // When: the source manifest is decoded.
    const sources = JSON.parse(provenance)

    // Then: both reviewed full commit hashes and the LazyCodex notice are present.
    expect(sources).toEqual({
      lazycodex: "f39306f1adab6ff155fd736cc7376d27156472bc",
      omp: "d0f90f35ae0f4aba48430b51a7203013dc0c5ff3",
    })
    expect(notice).toContain("LazyCodex")
    expect(notice).toContain("MIT License")
    await expect(
      readFile(join(root, "third_party", "lazycodex", "LICENSE"), "utf8"),
    ).resolves.toContain("Copyright (c) 2026 Yeongyu Kim")
  })
})
