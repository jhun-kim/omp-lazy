---
name: lcx-contribute-bug-fix(omp)
description: Prepare a verified omp-lazy or OMP bug-fix contribution in mandatory offline dry-run mode. Use when asked to fix and contribute a defect through /omp-lazy-contribute-bug-fix(omp) or /lcx-contribute-bug-fix(omp).
---

# Prepare a bug-fix contribution

Treat `/omp-lazy-contribute-bug-fix(omp)` and `/lcx-contribute-bug-fix(omp)` as the same `contribute_bug_fix` workflow. Both aliases produce identical typed results. `lcx-contribute-bug-fix(omp)` requires `--dry-run <issue-or-bug-ref>`; reject every other V1 form.

The contribution body inherits the canonical bug schema from `lcx-report-bug(omp)` (`bugId`, `title`, `severity`, `reproduction`, `expectedBehavior`, `actualBehavior`, `environment`, `artifacts[]`) plus fix-specific fields: `rootCause`, `fixDescription`, `testEvidence`, `verificationSteps`. Report and contribution schemas share one source of truth and cannot drift.

1. Confirm ownership from reproduction evidence. Stop when the requested target conflicts with the reproduced owner.
2. Dispatch one worker only for actual reproduction or fix work; dry-run mode skips dispatch when no reproduction or fix work is required. Create a fresh disposable workspace under the isolated evidence root and preserve the user's repository and OMP profile. Resolve all paths from literal arguments and preserve Windows paths as single argv entries.
3. Reproduce through the real failing surface and capture a RED regression test (`testEvidence`) before production changes.
4. Apply the smallest targeted fix, recording `rootCause` and `fixDescription`, then capture GREEN from the regression and adjacent suites.
5. Run a real OMP 17.0.5 surface check and record it in `verificationSteps`. Unit-only or mock-only evidence is insufficient.
6. Make an intentional local commit only inside the disposable workspace. Do not push it.
7. Generate the local body with the [PR body helper](scripts/create-pr-body.mjs), passing `--dry-run`, `--input`, and `--output` as literal argv entries.
8. Submit the RED, GREEN, real-surface, commit, body, and cleanup artifacts through `omp_lazy_accept_worker_result`. Parent acceptance is required; a worker self-report does not complete the workflow.
9. Remove only resources created by this run. Record cleanup failure and any foreign-state fingerprint change as blocking failures.

Return `externalWrite: not_run`. V1 performs no clone fetch, issue creation, pull-request creation, comment, label mutation, branch push, or other network write. External delivery requires a separate authorized plan after this dry run succeeds.
