import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

describe("package route labels", () => {
  it("labels a local candidate as link proof only", () => {
    // Given: a local candidate directory.
    const candidate = repositoryRoot

    // When: the Windows link lane describes its proof boundary.
    const result = run([
      "bun",
      "scripts/smoke-link-windows.ts",
      "--describe",
      "--candidate",
      candidate,
    ])

    // Then: local linking is never labeled npm installation.
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      npmInstallProof: false,
      proof: "symlink-required",
      route: "local-link",
    })
  })

  it("preserves a literal OMP executable path with spaces for local link proof", () => {
    // Given: a local candidate and a pinned OMP executable path containing spaces.
    const candidate = repositoryRoot
    const ompExecutable = join(repositoryRoot, ".fixture OMP Runtime", "omp.exe")

    // When: the Windows link lane describes its proof boundary with literal argv entries.
    const result = run([
      "bun",
      "scripts/smoke-link-windows.ts",
      "--describe",
      "--candidate",
      candidate,
      "--omp-exe",
      ompExecutable,
    ])

    // Then: the executable path is retained exactly and local linking remains non-npm proof.
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      npmInstallProof: false,
      ompExecutable,
      proof: "symlink-required",
      route: "local-link",
    })
  })

  it("labels real OMP dogfood as pinned local-host proof only", () => {
    // Given: a pinned OMP executable path with spaces.
    const ompExecutable = join(repositoryRoot, ".fixture OMP Runtime", "omp.exe")

    // When: the dogfood lane describes its real-host proof boundary.
    const result = run([
      "bun",
      "scripts/smoke-real-omp.ts",
      "--describe",
      "--omp-exe",
      ompExecutable,
    ])

    // Then: dogfood is not reported as a download or registry proof.
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      downloadProof: "NOT_RUN",
      npmInstallProof: false,
      ompExecutable,
      route: "pinned-real-omp",
      version: "16.4.8",
    })
  })

  it("labels staged tarball bytes as an ordinary-directory route", () => {
    // Given: a local tarball path.
    const tarball = join(repositoryRoot, "fixture.tgz")

    // When: the staged lane describes its proof boundary.
    const result = run(["bun", "scripts/smoke-staged.ts", "--describe", "--tarball", tarball])

    // Then: staged installability is distinct from OMP's npm branch.
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      installShape: "ordinary-directory",
      npmInstallProof: false,
      publicRegistry: "NOT_RUN",
      route: "staged-tarball",
    })
  })
})
