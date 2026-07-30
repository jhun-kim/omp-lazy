import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  discoverRepositoryRules,
  normalizeRuleSeparators,
  RuleDiscoveryError,
  readRepositoryRule,
  rulesRootPath,
} from "../../../src/context/rules-discovery"
import { temporaryRoot } from "../../fixtures/store-fixtures"

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function ruleRepository(label: string): Promise<string> {
  const root = await temporaryRoot(`rules-${label}`)
  sandboxes.push(root.displayPath)
  await mkdir(join(root.displayPath, ".omo", "rules"), { recursive: true })
  return root.displayPath
}

async function writeRule(repository: string, name: string, content: string): Promise<void> {
  await writeFile(join(rulesRootPath(repository), name), content)
}

const styleRule =
  '---\nglobs: ["src/**/*.ts"]\norder: 10\ndescription: Style rules\n---\n\nUse zod.\n'
const testRule = "---\nglobs:\n  - test/**/*.ts\n---\n\nNo fixed sleeps.\n"
const docsRule = '---\nglobs: ["**/*.md"]\norder: -5\n---\n\nKeep docs short.\n'

/** Creates a link inside the rules directory, preferring a Windows junction. */
async function linkRule(
  repository: string,
  name: string,
  targetDirectory: string,
): Promise<"junction" | "symlink"> {
  const linkPath = join(rulesRootPath(repository), name)
  if (process.platform === "win32") {
    try {
      await symlink(targetDirectory, linkPath, "junction")
      return "junction"
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  await symlink(join(targetDirectory, "target.md"), linkPath, "file")
  return "symlink"
}

describe("repository rule discovery", () => {
  test("Given three rule files When discovering Then results are sorted with parsed frontmatter", async () => {
    // Given
    const repository = await ruleRepository("happy")
    await writeRule(repository, "020-docs.md", docsRule)
    await writeRule(repository, "010-style.md", styleRule)
    await writeRule(repository, "015-test.md", testRule)
    await mkdir(join(rulesRootPath(repository), "nested"), { recursive: true })
    await writeFile(join(rulesRootPath(repository), "nested", "deep.md"), styleRule)
    await writeFile(join(rulesRootPath(repository), "notes.txt"), "ignored")

    // When
    const result = await discoverRepositoryRules(repository)

    // Then
    if (!result.ok) throw result.error
    expect(result.rules.map((rule) => rule.fileName)).toEqual([
      "010-style.md",
      "015-test.md",
      "020-docs.md",
    ])
    expect(result.rules.map((rule) => rule.relativePath)).toEqual([
      ".omo/rules/010-style.md",
      ".omo/rules/015-test.md",
      ".omo/rules/020-docs.md",
    ])
    expect(result.rules.map((rule) => rule.globs)).toEqual([
      ["src/**/*.ts"],
      ["test/**/*.ts"],
      ["**/*.md"],
    ])
    expect(result.rules.map((rule) => rule.order)).toEqual([10, null, -5])
    expect(result.rules.map((rule) => rule.description)).toEqual(["Style rules", null, null])
    expect(result.rules[0]?.body).toBe("Use zod.")
    expect(result.rejections).toEqual([])
  })

  test("Given a missing rules directory When discovering Then the result is empty and successful", async () => {
    // Given
    const root = await temporaryRoot("rules-absent")
    sandboxes.push(root.displayPath)

    // When
    const result = await discoverRepositoryRules(root.displayPath)

    // Then
    if (!result.ok) throw result.error
    expect(result.rules).toEqual([])
    expect(result.rejections).toEqual([])
  })

  test("Given a linked rule entry When discovering Then it is rejected and siblings survive", async () => {
    // Given
    const repository = await ruleRepository("link")
    await writeRule(repository, "010-style.md", styleRule)
    const outside = join(repository, "outside")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "target.md"), styleRule)
    const linkKind = await linkRule(repository, "999-linked.md", outside)

    // When
    const result = await discoverRepositoryRules(repository)

    // Then
    if (!result.ok) throw result.error
    expect(linkKind === "junction" || linkKind === "symlink").toBe(true)
    expect(result.rules.map((rule) => rule.fileName)).toEqual(["010-style.md"])
    expect(result.rejections).toHaveLength(1)
    const rejection = result.rejections[0]
    expect(rejection?.fileName).toBe("999-linked.md")
    expect(rejection?.error).toBeInstanceOf(RuleDiscoveryError)
    expect(rejection?.error.code).toBe("rule_link_rejected")
    expect(rejection?.error.reason).toContain("999-linked.md")
  })

  test("Given escaping rule names When reading Then containment is refused", async () => {
    // Given
    const repository = await ruleRepository("escape")
    await writeRule(repository, "010-style.md", styleRule)

    // When
    const parentEscape = await readRepositoryRule(repository, "../../010-style.md")
    const windowsEscape = await readRepositoryRule(repository, "..\\..\\010-style.md")
    const nested = await readRepositoryRule(repository, "nested/deep.md")
    const contained = await readRepositoryRule(repository, "010-style.md")

    // Then
    expect(parentEscape.ok).toBe(false)
    expect(windowsEscape.ok).toBe(false)
    expect(nested.ok).toBe(false)
    for (const refusal of [parentEscape, windowsEscape, nested]) {
      if (refusal.ok) throw new Error("expected a refusal")
      expect(refusal.error).toBeInstanceOf(RuleDiscoveryError)
      expect(refusal.error.code).toBe("rule_path_escaped")
    }
    if (!contained.ok) throw contained.error
    expect(contained.value.fileName).toBe("010-style.md")
  })

  test("Given malformed frontmatter When discovering Then each file yields a typed rejection", async () => {
    // Given
    const repository = await ruleRepository("malformed")
    await writeRule(repository, "010-no-frontmatter.md", "# plain markdown\n")
    await writeRule(repository, "020-unterminated.md", '---\nglobs: ["a"]\n')
    await writeRule(repository, "030-wrong-type.md", "---\nglobs: 7\n---\nbody\n")
    await writeRule(repository, "040-unknown-key.md", '---\nglobs: ["a"]\nscope: all\n---\nbody\n')
    await writeRule(repository, "050-bad-order.md", '---\nglobs: ["a"]\norder: soon\n---\nbody\n')
    await writeRule(
      repository,
      "060-escaping-glob.md",
      '---\nglobs: ["../outside/**"]\n---\nbody\n',
    )
    await writeRule(repository, "070-valid.md", styleRule)

    // When
    const result = await discoverRepositoryRules(repository)

    // Then
    if (!result.ok) throw result.error
    expect(result.rules.map((rule) => rule.fileName)).toEqual(["070-valid.md"])
    expect(result.rejections.map((rejection) => rejection.fileName)).toEqual([
      "010-no-frontmatter.md",
      "020-unterminated.md",
      "030-wrong-type.md",
      "040-unknown-key.md",
      "050-bad-order.md",
      "060-escaping-glob.md",
    ])
    for (const rejection of result.rejections) {
      expect(rejection.error).toBeInstanceOf(RuleDiscoveryError)
      expect(rejection.error.code).toBe("malformed_rule_frontmatter")
      expect(rejection.error.reason.length).toBeGreaterThan(0)
    }
  })

  test("Given backslash and slash inputs When discovering Then results are identical", async () => {
    // Given
    const repository = await ruleRepository("separators")
    await writeRule(repository, "010-style.md", '---\nglobs: ["src\\**\\*.ts"]\n---\nbody\n')
    await writeRule(repository, "020-posix.md", '---\nglobs: ["src/**/*.ts"]\n---\nbody\n')
    const slashInput = repository.replaceAll("\\", "/")
    const platformInput =
      process.platform === "win32" ? repository.replaceAll("/", "\\") : repository

    // When
    const slashResult = await discoverRepositoryRules(slashInput)
    const platformResult = await discoverRepositoryRules(platformInput)

    // Then
    if (!slashResult.ok) throw slashResult.error
    if (!platformResult.ok) throw platformResult.error
    expect(slashResult.rules).toEqual(platformResult.rules)
    expect(slashResult.rules.map((rule) => rule.globs)).toEqual([["src/**/*.ts"], ["src/**/*.ts"]])
    for (const rule of slashResult.rules) {
      expect(rule.relativePath).not.toContain("\\")
    }
    expect(normalizeRuleSeparators("src\\**\\*.ts")).toBe("src/**/*.ts")
    expect(normalizeRuleSeparators("src/**/*.ts")).toBe("src/**/*.ts")
  })

  test("Given a rules directory that is a link When discovering Then the root is refused", async () => {
    // Given
    const root = await temporaryRoot("rules-root-link")
    sandboxes.push(root.displayPath)
    const outside = join(root.displayPath, "outside-rules")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "010-style.md"), styleRule)
    const repository = join(root.displayPath, "repository")
    await mkdir(join(repository, ".omo"), { recursive: true })
    await symlink(outside, join(repository, ".omo", "rules"), "junction")

    // When
    const result = await discoverRepositoryRules(repository)

    // Then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refused rules root")
    expect(result.error).toBeInstanceOf(RuleDiscoveryError)
    expect(result.error.code).toBe("rules_root_escaped")
  })
})
