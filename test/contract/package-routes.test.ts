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
