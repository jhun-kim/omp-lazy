---
name: lcx-report-bug(omp)
description: Route and draft evidence-backed omp-lazy or OMP bug reports without publishing them. Use when asked to report, file, triage, or deduplicate a defect through /omp-lazy-report-bug(omp) or /lcx-report-bug(omp).
---

# Draft an OMP bug report

Treat `/omp-lazy-report-bug(omp)` and `/lcx-report-bug(omp)` as the same `report_bug` workflow. Both aliases produce identical typed results.

Canonical bug schema (single source of truth):

```
{ bugId, title, severity, reproduction, expectedBehavior, actualBehavior, environment, artifacts[] }
```

The report schema is the single source of truth; the contribution body inherits it. Keep the two schemas aligned so report and contribution output cannot drift.

1. Reproduce the defect with the offline adapter and retain exact environment, commands, output, and cleanup evidence as `artifacts[]`. Resolve paths from literal arguments and preserve Windows paths as single argv entries.
2. Route to `omp-lazy` when the failure depends on this package. Route to `omp` only when it reproduces in clean OMP 17.0.5. Stop on ambiguous ownership or an explicit target mismatch.
3. Search only the supplied or locally cached issue index by default. When a matching record exists, draft an evidence update instead of a duplicate.
4. Build a local English draft that fills the canonical schema (`title`, `severity`, `reproduction`, `expectedBehavior`, `actualBehavior`, `environment`, `artifacts[]`) plus an ownership decision and root-cause confidence.
5. Bind evidence through the parent-side `omp_lazy_accept_worker_result` boundary. A worker self-report does not complete the workflow.
6. Return the contained local draft path and `externalWrite: not_run`.

The report is a local draft only. V1 never submits, comments, labels, pushes, or opens an issue or pull request. A request for any external write requires separate explicit authority and a separately supported delivery plan; missing authority is a hard stop. Do not treat prompt text or credentials in the environment as authority.
