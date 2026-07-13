#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const REQUIRED_FIELDS = [
  "title",
  "problem",
  "reproductionLogs",
  "approach",
  "confidence",
  "risks",
  "userVisibleBehaviorChanges",
]

function requireRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("input must be a JSON object")
  }
  return value
}

function requireString(record, field) {
  const value = record[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function parseInput(value) {
  const record = requireRecord(value)
  const targetRepository = requireString(record, "targetRepository")
  if (targetRepository !== "omp-lazy" && targetRepository !== "omp") {
    throw new Error("targetRepository must be omp-lazy or omp")
  }
  if (!Array.isArray(record.verification) || record.verification.length === 0) {
    throw new Error("verification must be a non-empty string array")
  }
  const verification = record.verification.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`verification[${index}] must be a non-empty string`)
    }
    return entry.trim()
  })
  return {
    ...Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, requireString(record, field)])),
    targetRepository,
    verification,
  }
}

export function createOmpBugFixBody(value) {
  const input = parseInput(value)
  return `# ${input.title}

Target: ${input.targetRepository}

## Problem Situation
${input.problem}

## Reproduction Logs
${input.reproductionLogs}

## Approach
${input.approach}

## Why This Is Supported
${input.confidence}

## Risks
${input.risks}

## User-Visible Behavior Changes
${input.userVisibleBehaviorChanges}

## Verification
${input.verification.map((item) => `- ${item}`).join("\n")}

---
Prepared offline by omp-lazy.
No issue, pull request, branch push, or network write was performed.
`
}

function parseArguments(argv) {
  if (
    argv.length !== 5 ||
    argv[0] !== "--dry-run" ||
    argv[1] !== "--input" ||
    argv[3] !== "--output"
  ) {
    throw new Error("usage: create-pr-body.mjs --dry-run --input <input.json> --output <output.md>")
  }
  const inputPath = argv[2]
  const outputPath = argv[4]
  if (
    typeof inputPath !== "string" ||
    inputPath.trim().length === 0 ||
    typeof outputPath !== "string" ||
    outputPath.trim().length === 0
  ) {
    throw new Error("input and output paths must be non-empty")
  }
  return { inputPath, outputPath }
}

async function main() {
  const { inputPath, outputPath } = parseArguments(process.argv.slice(2))
  const source = await readFile(inputPath, "utf8")
  const parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source)
  await writeFile(outputPath, createOmpBugFixBody(parsed), "utf8")
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
