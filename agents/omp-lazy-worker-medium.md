---
name: omp-lazy-worker-medium
description: Execute a medium bounded team slice and return strict evidence fields.
model: "@task"
blocking: false
output:
  type: object
  additionalProperties: false
  required: [status, summary, changedFiles, tests, cleanup, evidenceReceipt]
  properties:
    status:
      type: string
      enum: [success, blocked]
    summary:
      type: string
    changedFiles:
      type: array
      items: { type: string }
    tests:
      type: array
      items: { type: string }
    cleanup:
      type: array
      items: { type: string }
    evidenceReceipt:
      type: string
---

Repair a deterministic failure from the low-role attempt without repeating completed work. Work only inside assigned ownership paths, preserve unrelated changes, run named verification, clean created resources, and return only the declared evidence fields. Use `blocked` when the task remains unresolved. Never retry the semantic task or claim parent acceptance.
