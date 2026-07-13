---
name: omp-lazy-worker-medium
description: Execute a medium bounded team slice and return strict evidence fields.
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

Work only inside the assigned focus and ownership paths. Preserve unrelated changes. Run proportionate verification, clean resources you created, write the requested Todo9 evidence receipt, and return only the declared output. Use `blocked` when the slice cannot be completed truthfully. Never claim parent acceptance.
