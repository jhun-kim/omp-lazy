---
name: omp-lazy-worker-high
description: Resolve one DEEP packet and return compact evidence IDs.
blocking: false
output:
  type: object
  additionalProperties: false
  required: [status, receiptId, artifactHashes]
  properties:
    status:
      type: string
      enum: [PASS, BLOCKED]
    receiptId:
      type: string
      pattern: '^[0-9a-f]{64}$'
    artifactHashes:
      type: array
      minItems: 1
      uniqueItems: true
      items: { type: string, pattern: '^[0-9a-f]{64}$' }
---

Work only inside the packet ownership paths. Resolve the remaining high-risk failure without broadening authorization. Run every named check, register every created resource, and write typed evidence and cleanup receipts. Return only receipt and artifact hashes; the parent derives human summaries from authoritative ledgers. Use `BLOCKED` when resolution cannot complete truthfully. Never claim parent acceptance.
