# omp-lazy

English | [한국어](README.ko.md)

`omp-lazy` is an MIT-licensed, source-only TypeScript extension for OMP 17.x. The source is
maintained in this public repository, while `package.json#private` prevents accidental registry
publication. The extension loads from `package.json#omp.extensions` under Bun and does not locate,
download, or import a different host installation.

## What it adds to OMP

- Durable planning and execution through `/ulw-plan(omp)` and `/start-work(omp)`.
- Capability-checked multi-agent coordination through `/teammode(omp)`.
- Bounded autonomous workflows through `/ulw-loop(omp)` and `/ultrawork(omp)`.
- Evidence-saturated investigation through `/ulw-research(omp)`.
- Local, non-delivering LazyCodex diagnostics and contribution drafts.
- Repository-scoped state, immutable worker identity binding, parent acceptance, and release-grade
  verification gates.

## Requirements

- Bun 1.3.14 and the committed `bun.lock`.
- Git, because candidate and evidence provenance bind to a clean tracked worktree and `HEAD`.
- OMP 17.x. Development and host verification are pinned to OMP 17.0.5; other major versions are
  rejected before plugin or profile operations.
- A source checkout of this repository.
- Windows Developer Mode or equivalent symlink permission for Windows link-path coverage.

No registry credentials, publishing token, API secret, or network-write permission is needed.
The deterministic host preflight uses a loopback provider and a non-secret fixture key.

## Source installation

From the repository root, install only the locked dependencies:

```sh
bun install --frozen-lockfile
```

For an operator-managed source link, run the pinned OMP 17.x executable from the checkout:

```sh
omp plugin link . --json
omp plugin list --json
omp plugin doctor --json
```

This link is the installation. There is no npm installation or public tarball route. The release
gates use disposable profiles; the commands above intentionally affect the operator's selected OMP
profile and should therefore be run only when that private link is desired.

## Local verification

The fast developer gate is intentionally limited to typecheck, lint, unit, contract, and
integration coverage:

```sh
bun run check
```

The authoritative release gate runs every fast gate and then skill sync, README contract,
source loader/discovery, committed candidate packing, ordinary-directory staged smoke, hostile
G01-G29 replay, pinned host preflight, and the platform host gate. Windows runs link/list/doctor
coverage; Linux and other POSIX hosts run pinned dogfood with profile fingerprint verification.
Every subgate is mandatory and empty or non-PASS structured evidence fails the release:

```sh
bun run verify:release
```

The release CLI validates full structured receipts internally but prints only per-gate PASS
summaries. Host profile paths, sandbox roots, and profile fingerprints are not written to public CI
logs.

`pack:candidate`, `smoke:staged`, and evidence manifests require committed bytes. Run release and
manifest generation only from a clean tracked worktree. Generated tarballs and receipts remain
ignored local artifacts.

## Verification matrix

| Surface | Fast `check` | `verify:release` | Windows CI | Linux CI |
| --- | --- | --- | --- | --- |
| Type, lint, unit, contract, integration | Yes | Yes | Yes | Yes |
| Skill sync and README contract | No | Yes | Yes | Yes |
| Source loader and discovery | No | Yes | Yes | Yes |
| Committed candidate pack and staged install | No | Yes | Yes | Yes |
| Hostile G01-G29 replay | No | Yes | Yes | Yes |
| Pinned OMP 17.0.5 preflight | No | Yes | Yes | Yes |
| OMP link/list/doctor path | No | Windows | Yes | Through dogfood |
| Pinned OMP dogfood/profile fingerprint | No | POSIX | No | Yes |
| Publish or registry upload | No | No | No | No |

## Harness evaluation

The harness evaluator (`harness-eval/`) is a frozen closure: its bytes and the corpus manifest are
not edited while evidence is being produced. Evaluation runs in three modes.

- **Deterministic.** `bun run eval:harness:deterministic` runs the corpus against a synthetic
  target with no registry credentials, network writes, or live model access. It validates fixture,
  oracle, and adapter contracts and is the only harness mode required by the fast and release
  gates. A deterministic `PASS` proves the corpus contract holds; it is not a live quality result.
- **Baseline.** `bun run eval:harness:baseline` replays the frozen pre-redesign defect set so
  regressions stay visible.
- **Live.** `bun run eval:harness:live` runs credentialed paired profiles. It requires the
  non-secret operator input `.omo/inputs/harness-live-profile.v1.json`, validated against the
  frozen schema before any model call. The secret key stays environment-only and is never read
  from this file.

A missing or schema-invalid live input is `BLOCKED: live_profile_input_missing` (or
`live_profile_input_schema_invalid`), never a synthetic `PASS`. `bun run verify:harness` verifies
frozen receipts and distinguishes a deterministic `PASS` from a live `PASS` or `BLOCKED` outcome.
Quality and cost ratios are reported only when a live comparison has actually been measured; no
release surface advertises a 10% cost or 95% quality figure that has not been observed. Missing
auditor or live credentials leaves final approval `BLOCKED`, and a `BLOCKED` result is final: it
cannot be claimed as an approval.

## Package scripts

The alias and expansion columns are an exact machine-checked mirror of `package.json#scripts`.

| Alias | Expansion | Purpose |
| --- | --- | --- |
| `typecheck` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile unit -- bun scripts/run-local-tsc.ts --noEmit` | Locked local TypeScript check. |
| `lint` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bunx biome check .` | Biome lint and formatting check. |
| `test:unit` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun test test/unit` | Unit suite. |
| `test:contract` | `bun scripts/run-isolated.ts --timeout-ms 240000 --cwd . --env-profile unit -- bun test --timeout 30000 test/contract` | Product and boundary contracts. |
| `test:integration:core` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun test test/integration` | Core integration suite. |
| `test:integration:capability` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile omp -- bun test test/host-integration` | Isolated real-OMP capability suite. |
| `test:integration` | `bun scripts/run-integration.ts` | Serial core and real-OMP capability suites. |
| `test:hostile` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/replay-hostile.ts` | Bounded hostile G01-G29 replay. |
| `test:regression` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun test test/contract/regression.test.ts` | Focused regression suite. |
| `preflight:omp` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile omp -- bun scripts/preflight-real-omp.ts` | Pinned host and async preflight. |
| `smoke:loader` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun scripts/probe-loader.ts` | Source entrypoint inventory. |
| `smoke:discovery` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun scripts/probe-discovery.ts` | Source skill and agent discovery. |
| `pack:candidate` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/pack-candidate.ts` | Pack clean committed bytes. |
| `smoke:link:windows` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile omp -- bun scripts/smoke-link-windows.ts` | Windows link/list/doctor path. |
| `smoke:staged` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/smoke-staged.ts` | Ordinary-directory tarball install. |
| `dogfood:omp` | `bun scripts/run-isolated.ts --timeout-ms 600000 --cwd . --env-profile omp -- bun scripts/smoke-real-omp.ts` | Pinned real-host dogfood. |
| `verify:candidate` | `bun scripts/run-isolated.ts --timeout-ms 1200000 --cwd . --env-profile integration -- bun scripts/verify-candidate.ts` | Verify an explicit hostile evidence bundle. |
| `verify:skills` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun scripts/assert-skill-sync.ts` | Exact command-to-skill sync. |
| `verify:readme` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun scripts/verify-readme-contract.ts` | README/package/runtime contract. |
| `evidence:source` | `bun scripts/build-evidence-manifest.ts --mode source --root .omo/evidence/plugin-completion-60 --commit-from-git-head` | Bind T01-T15 evidence to clean `HEAD`. |
| `evidence:review` | `bun scripts/build-evidence-manifest.ts --mode review --root .omo/evidence/plugin-completion-60 --commit-from-git-head` | Bind source plus F1-F4 receipts. |
| `eval:harness:deterministic` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts run --mode deterministic --manifest harness-eval/manifest.v1.json --validate-corpus --synthetic-target harness-eval/fixtures/synthetic-target` | Run the deterministic harness corpus. |
| `eval:harness:baseline` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts run --mode baseline` | Run frozen baseline harness defects. |
| `eval:harness:live` | `bun scripts/run-isolated.ts --timeout-ms 7200000 --cwd . --env-profile omp -- bun harness-eval/src/cli.ts run --mode live` | Run credentialed live harness evaluation. |
| `verify:harness` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts verify` | Verify frozen harness receipts. |
| `evidence:harness:source` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts evidence --mode source` | Build the harness source evidence manifest. |
| `evidence:harness:review` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts evidence --mode review` | Build the harness review evidence manifest. |
| `check` | `bun scripts/check.ts` | Fast local gate. |
| `verify:release` | `bun scripts/verify-release.ts` | Authoritative platform release gate. |

`verify:candidate` accepts `--bundle <verdict.json>` after the package-script separator when
investigating a supplied hostile bundle. It is not a substitute for live `verify:release`.

## Runtime behavior

| Behavior | Description |
| --- | --- |
| `directive_activation` | An allowlisted trigger token in a user prompt activates the matching workflow directive as a hidden injected message, with the user's own text byte-identical. |
| `idle_continuation` | An active start-work plan or ulw-loop goal continues itself on agent idle under a bounded, persisted counter, with a steering reminder instead of a rewritten prompt. |
| `delegation_model_chains` | Each agent declares an ordered model chain plus thinkingLevel; chain fallback is attempted in order with per-attempt provenance, and blocked spawns return a corrective reason. |
| `status_line` | The OMP status line and working message show the active workflow, run, progress and model role, degrading silently when there is no UI. |
| `rules_injection` | Repository-scoped .omo/rules/*.md glob-matched rules and a truncation-safe directive/skill catalog are assembled under an explicit byte budget with deterministic priority. |

## Product commands

Both canonical names and aliases are registered exactly once.

| Command | Workflow |
| --- | --- |
| `/lcx-contribute-bug-fix(omp)` | Offline dry-run contribution workflow. |
| `/lcx-doctor(omp)` | Read-only health diagnosis. |
| `/lcx-report-bug(omp)` | Local report draft. |
| `/omp-lazy-contribute-bug-fix(omp)` | Canonical contribution command. |
| `/omp-lazy-doctor(omp)` | Canonical doctor command. |
| `/omp-lazy-report-bug(omp)` | Canonical report command. |
| `/omp-lazy-start-work(omp)` | Canonical plan execution command. |
| `/omp-lazy-teammode(omp)` | Canonical durable team command. |
| `/omp-lazy-ultrawork(omp)` | Canonical ultrawork command. |
| `/omp-lazy-ulw-deliver(omp)` | Canonical full-lifecycle delivery command. |
| `/omp-lazy-ulw-plan(omp)` | Canonical planning command. |
| `/omp-lazy-ulw-research(omp)` | Canonical research command. |
| `/start-work(omp)` | Plan execution alias. |
| `/teammode(omp)` | Durable team alias. |
| `/ultrawork(omp)` | Ultrawork alias. |
| `/ulw(omp)` | Short ultrawork alias. |
| `/ulw-deliver(omp)` | Full-lifecycle delivery alias. |
| `/ulw-loop(omp)` | Bounded loop command. |
| `/ulw-plan(omp)` | Planning alias. |
| `/ulw-research(omp)` | Research alias. |

## Skills

| Skill | Purpose |
| --- | --- |
| `lcx-contribute-bug-fix(omp)` | Builds a local dry-run contribution proposal. |
| `lcx-doctor(omp)` | Diagnoses local LazyCodex and OMP health read-only. |
| `lcx-report-bug(omp)` | Builds a contained local bug-report draft. |
| `start-work(omp)` | Executes approved `.omo/plans` with evidence and parent acceptance. |
| `teammode(omp)` | Coordinates capability-proven, non-overlapping durable teams. |
| `ultrawork(omp)` | Drives rigorous bounded execution. |
| `ulw-deliver(omp)` | Orchestrates sequential Plan, Implement, Verify, QA delivery. |
| `ulw-loop(omp)` | Repeats a bounded goal-independent workflow. |
| `ulw-plan(omp)` | Produces a decision-complete plan before execution. |
| `ulw-research(omp)` | Runs evidence-saturated research with retained attribution. |

## Agents

| Agent | Role |
| --- | --- |
| `omp-lazy-explorer` | Repository exploration. |
| `omp-lazy-librarian` | External documentation and source research. |
| `omp-lazy-metis` | Planning ambiguity analysis. |
| `omp-lazy-momus` | Plan critique. |
| `omp-lazy-planner` | Decision-complete planning. |
| `omp-lazy-qa` | Product-surface verification. |
| `omp-lazy-researcher` | Saturated research. |
| `omp-lazy-reviewer` | Parent acceptance review. |
| `omp-lazy-worker-high` | High-complexity execution. |
| `omp-lazy-worker-low` | Low-complexity execution. |
| `omp-lazy-worker-medium` | Medium-complexity execution. |

The runtime also registers one tool, `omp_lazy_accept_worker_result`, and one handler for each of
`input`, `before_agent_start`, `session_stop`, `tool_call`, and `tool_result`.

## Durable state

Repository state lives only below `<repository>/.omo/omp-lazy`. Runs, events, the active index,
locks, and recovery files remain repository-scoped. Canonical path checks reject symlink or Windows
junction escapes before mutation. Release and host gates use disposable homes, profiles, temporary
directories, and worktree roots; they do not mutate a pre-existing operator profile or state root.
These checks reject static redirected paths at each operation boundary; they do not claim protection
against a separate hostile OS process concurrently changing filesystem topology because Bun does not
expose a portable `openat`-style relative filesystem API.

On Windows, a capability-probe receipt proves direct launcher exit plus its provider and sandbox
cleanup. It does not prove containment of arbitrary descendants after their launcher exits; that
requires pre-enrollment in a Windows Job Object, which the pinned host runtime does not expose.
Cooperative child cleanup remains covered by its existing bounded tests.

## Migration

Durable state records carry an explicit `schemaVersion`. The lifecycle store migrates legacy v1
records to v2 automatically on first access, under the repository lock, before any mutation.

- **Automatic v1→v2 migration.** On first access to a legacy state root, every active, run, event,
  team, task-fact, acceptance, WAL, and rejection record is converted from schema v1 to v2 in one
  journaled transaction. A rerun against an already-current root is a no-op.
- **Rollback on failure.** The migration journals each step and backs up the original v1 bytes
  first. A crash or verification failure at any publication step restores the complete v1 set; the
  store never leaves a partially migrated mix.
- **Refusal of unknown versions.** Records with a future or unknown `schemaVersion` are refused
  with `unknown_schema_version` rather than guessed at. Damaged backups or ambiguous record
  identities fail closed with `migration_recovery_required`.
- **Legacy plans need reapproval.** Normalizing a v1 plan into a v2 view never migrates its text
  approval. A legacy plan requires one trusted reapproval before execution; historical v1 events
  remain audit-only and cannot settle v2 work.

## Evidence handoff

`.omo/evidence/**` is ignored and must never be tracked. A source evidence root contains the exact
T01-T15 receipt set plus the explicit T14 G01-G29 sidecars and only the raw files referenced by the
T14 aggregate and rejection receipts. The builder rejects missing, extra, empty, symlinked,
escaping, changed, or non-regular files and writes canonical sorted SHA-256 entries.

After the T15 commit is `HEAD` and tracked files are clean, generate the source manifest:

```sh
bun run evidence:source
```

Pass the canonical absolute path printed in
`.omo/evidence/plugin-completion-60/final/evidence-manifest.json` to independent F1-F4 reviewers.
Each reviewer verifies source hashes before writing its named receipt beside the manifest. After
exactly four unconditional `APPROVE` reviews and the required F2 release log exist at the unchanged
commit, generate the review manifest:

```sh
bun run evidence:review
```

The review builder revalidates every source hash, requires the exact final-wave files, and binds
their hashes plus the source-manifest hash to the same Git `HEAD`. Coordinator integration changes
the commit SHA, so the coordinator must rerun `bun run evidence:source` after integration and before
dispatching F1-F4.

## Offline LCX limits

LCX report and contribution workflows are local and non-delivering. `lcx-report-bug(omp)` records
`externalWrite: not_run`; `lcx-contribute-bug-fix(omp)` requires `--dry-run`. They do not create issues,
pull requests, pushes, releases, uploads, or other network writes. `lcx-doctor(omp)` is read-only. An
operator must separately review and deliver any generated draft outside this plugin.

## Troubleshooting

- `unsupported_host_version`: update to OMP 17.x; release verification is pinned to 17.0.5. When
  OMP updates, update both exact development pins and rerun `bun run verify:release`.
- `missing_executable`: run `bun install --frozen-lockfile` and confirm the exact local OMP 17.0.5
  development dependency is present, or pass a literal executable only to the underlying host
  diagnostic when investigating.
- Windows symlink failure: enable Developer Mode or use an elevated environment, then rerun
  `bun run preflight:omp` and `bun run smoke:link:windows`.
- Candidate worktree changed after packaging: commit intended tracked changes, remove unintended
  tracked changes, then rerun candidate packing and staged smoke. Never reuse a stale tarball.
- Missing or empty staged/hostile evidence: rerun the owning live gate. Do not create placeholder
  receipts or downgrade a missing subgate to a soft pass.
- Evidence manifest extra-file failure: use a copied evidence root for experiments and keep the
  canonical root exhaustive. Remove only the undeclared copied artifact, not a required receipt.

## Source and attribution

Workflow concepts and selected skill assets were adapted from
[LazyCodex](https://github.com/code-yeongyu/lazycodex) at commit
`f39306f1adab6ff155fd736cc7376d27156472bc`, under the MIT License. OMP compatibility was reviewed
against [Oh My Pi](https://github.com/can1357/oh-my-pi). Full provenance and third-party notices are
recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`third_party/SOURCE_COMMITS.json`](third_party/SOURCE_COMMITS.json).

## License

This project is licensed under the [MIT License](LICENSE).
