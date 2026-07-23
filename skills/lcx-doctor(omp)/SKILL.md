---
name: lcx-doctor(omp)
description: Diagnose OMP and omp-lazy installation or workflow health without mutation. Use for health checks, post-install drift, broken loading, command or skill discovery failures, and compatibility invocations through /omp-lazy-doctor(omp) or /lcx-doctor(omp).
---

# Diagnose omp-lazy

Treat `/omp-lazy-doctor(omp)` and `/lcx-doctor(omp)` as the same `doctor` workflow. Both aliases produce identical typed results.

1. Use the offline adapter unless the user separately authorizes network access. Resolve the project root, OMP executable, package manifest, and evidence root from literal arguments. Preserve Windows paths as single argv entries.
2. Shallow mode requires no task dispatch; capture OMP version, package metadata, declared payload, skill discovery, and loader results directly. Deep mode dispatches one worker for verification and adds a nonrecursive real OMP probe in a disposable profile.
3. Compare only supplied or locally materialized sources. Mark unavailable online freshness checks `NOT_RUN`; never fetch implicitly.
4. Emit PASS, WARN, or FAIL for every check with its captured command or file evidence.
5. Record cleanup and verify the real OMP profile fingerprint is unchanged.

Output is compact and evidence-bound: the doctor returns an overall verdict (`pass`, `warn`, or `fail`) plus one check receipt per observation (`{ id, verdict, evidence }`), the `read_only` policy, and `externalWrite: not_run`. A check whose evidence is blank can never produce an overall PASS, and no evidence is invented.

`lcx-doctor(omp)` is read-only. Do not edit config, repair state, install packages, sync sources, create external artifacts, or reuse doctor output as loader proof. Propose a later remediation when mutation is required.
