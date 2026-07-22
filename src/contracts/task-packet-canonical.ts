function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function compareOrdinalStrings(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareOrdinalStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  throw new TypeError("packet contains non-JSON value")
}

export function normalizeNfc(value: string): string {
  return value.normalize("NFC")
}

export function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareOrdinalStrings)
}

export function sortedUniqueStrings(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareOrdinalStrings(values[index - 1] ?? "", value) < 0,
  )
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftMembers = new Set(left)
  const rightMembers = new Set(right)
  return (
    leftMembers.size === rightMembers.size &&
    [...leftMembers].every((member) => rightMembers.has(member))
  )
}
