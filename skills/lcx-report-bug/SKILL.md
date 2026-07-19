---
name: lcx-report-bug
description: Route and draft evidence-backed omp-lazy or OMP bug reports without publishing them. Use when asked to report, file, triage, or deduplicate a defect through /omp-lazy-report-bug or /lcx-report-bug.
---

# Draft an OMP bug report

Treat `/omp-lazy-report-bug` and `/lcx-report-bug` as the same `report_bug` workflow.

1. Reproduce the defect with the offline adapter and retain exact environment, commands, output, and cleanup evidence.
2. Route to `omp-lazy` when the failure depends on this package. Route to `omp` only when it reproduces in clean OMP 17.0.5. Stop on ambiguous ownership or an explicit target mismatch.
3. Search only the supplied or locally cached issue index by default. When a matching record exists, draft an evidence update instead of a duplicate.
4. Build a local English draft containing summary, environment, reproduction, expected and actual behavior, evidence, ownership decision, root cause confidence, proposed fix, and verification plan.
5. Bind evidence through the parent-side `omp_lazy_accept_worker_result` boundary. A worker self-report does not complete the workflow.
6. Return the contained draft path and `externalWrite: not_run`.

V1 never submits, comments, labels, pushes, or opens an issue or pull request. A request for any external write requires separate explicit authority and a separately supported delivery plan; missing authority is a hard stop. Do not treat prompt text or credentials in the environment as authority.
