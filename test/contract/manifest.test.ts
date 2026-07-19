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
      "@oh-my-pi/pi-coding-agent": ">=17.0.5 <18",
    })
    expect(manifest.peerDependenciesMeta).toEqual({
      "@oh-my-pi/pi-coding-agent": { optional: true },
    })
    expect(manifest.dependencies).toEqual({ zod: "4.4.3" })
    expect(manifest.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("17.0.5")
    expect(manifest.devDependencies.zod).toBeUndefined()
    expect(manifest.dependencies?.["@oh-my-pi/pi-coding-agent"]).toBeUndefined()
  })

  it("lists the required skill-sync verifier in the packed file allowlist", async () => {
    // Given: the package manifest explicitly owns selected runtime support files.
    const raw = await readFile(join(root, "package.json"), "utf8")

    // When: the files allowlist is decoded.
    const manifest = JSON.parse(raw)

    // Then: the T07 sync verifier stays packaged until T10 generalizes all file checks.
    expect(manifest.files).toContain("scripts/assert-skill-sync.ts")
    expect(manifest.files).toContain("README.ko.md")
    await expect(
      readFile(join(root, "scripts", "assert-skill-sync.ts"), "utf8"),
    ).resolves.toContain("parseFrontmatter")
  })

  it("keeps public OMP provenance independent of a maintainer home directory", async () => {
    // Given: the distributable OMP provenance document.
    const source = await readFile(join(root, "third_party", "omp", "SOURCE.md"), "utf8")

    // When: its public text is inspected.
    const homePath = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|AppData[\\/])/u

    // Then: no maintainer-specific home or application-data path is published.
    expect(source).not.toMatch(homePath)
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
      omp: "9fd6e97113f5ed3a847e66d346970efdf8afcad9",
    })
    expect(notice).toContain("LazyCodex")
    expect(notice).toContain("MIT License")
    await expect(
      readFile(join(root, "third_party", "lazycodex", "LICENSE"), "utf8"),
    ).resolves.toContain("Copyright (c) 2026 Yeongyu Kim")
  })
})
