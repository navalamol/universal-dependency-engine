# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-21

---

## Phase 1 — ✅ COMPLETE (2026-08-12)

All 26 Phase 1 scenarios done. 48/48 tests passing. Regression baseline A:5 B:0 C:3 confirmed.

| Completed item | Date |
|----------------|------|
| git-commits.js wiring (`--commit` flag) | 2026-08-12 |
| PR description generation (`pr-description.js`) | 2026-08-12 |
| Maven dep-tree parser (`dep-tree.js`) | 2026-08-12 |
| V1 blockers (exit codes, control flow, Maven range field) | 2026-08-12 |
| `enrichWithConfidence` wired into mendfix CLI path | 2026-08-12 |

---

## Phase 1.x — Remediation Path Explorer (current)

### ~~Step A/B: Manifest inspection per candidate parent version~~ ✅ DONE 2026-08-12

- `registry.js` — added `getManifest(name, version)` with per-run cache (`_manifestCache`)
- `parent-upgrade-explorer.js` — removed local `fetchJson`/`getVersionDeps`; uses `getManifest` from registry; applies `CANDIDATE_LIMIT = 10` per level; adds `manifestVerified: true` to returned path objects

### ~~Step C: Isolated package-manager simulation~~ ✅ DONE 2026-08-12

- New `src/ecosystems/npm/simulator.js` — temp-dir npm install, lockfile inspection, hash cache, timeout, limit guardrails
- Wired into `parent-upgrade-explorer.js` — stamps `simulationVerified: true` on confirmed paths

### ~~Step E: Multi-path comparison + Change Budget ranking~~ ✅ DONE 2026-08-12

- New `src/core/remediation-paths.js` — `buildPaths`, `rankPaths`, `comparePaths`, `enrichWithPaths`
- Adds `recommendedPath`, `alternativePaths[]`, `decisionLabel` to every PhasedItem
- Wired into `mendfix.js` after `enrichWithConfidence`; `decisionLabel` now shown in report + manual-review.md
- 16 new tests; 48/48 total passing

### ~~Steps 6–11: V1.x Enhancements~~ ✅ DONE 2026-08-12

| # | Enhancement | Status |
|---|-------------|--------|
| 6 | Security verification in simulated graph (`security-delta.js`) | ✅ DONE |
| 7 | Dependency blast radius (`buildBlastRadius` in `lock-parser.js`) | ✅ DONE |
| 8 | Safety Gate pre-edit checklist + `--verbose` / `--force` flags | ✅ DONE |
| 9 | Decision label taxonomy in Phase A/B report + PR description | ✅ DONE |
| 10 | Mixed dev/runtime chain classification (Scenario 8 full) | ✅ DONE |
| 11 | Renovate PR relationship analysis (`analyzePRRelationships`) | ✅ DONE |

---

### ~~Step G: Recursive parent-chain exploration with guardrails~~ ✅ DONE 2026-08-12

- `recursiveResolveChainChildRange` replaces `resolveChainChildRange` — explores all candidate versions at each intermediate hop (not just latest)
- All 9 guardrails applied: cycle detection, depth limit (5), candidate limit (10), simulation limit (20), registry cache, deterministic ordering
- Key invariant: function only propagates a child range if it covers `fixVersion` (checked at leaf)
- New CLI flags: `--max-depth`, `--max-simulations`
- 28 new tests in `tests/ecosystems/npm/parent-upgrade-explorer.test.js`
- 86/86 tests passing; regression baseline A:5 B:0 C:3 confirmed

---

## Phase 2 — Universal Finding Engine ✅ COMPLETE (2026-08-12)

### ✅ Step 1: Snyk provider — DONE 2026-08-12

- `src/providers/snyk.js` — `parseReport(filePath)` + `isSnykFormat(data)`
- Supports 3 Snyk output shapes: standard `snyk test --json`, `--all-projects`, flat array
- `src/providers/index.js` — Snyk detection wired before Mend fallback
- 20 new tests in `tests/providers/snyk.test.js`; 106/106 total passing; baseline A:5 B:0 C:3 confirmed

### ✅ Step V2-13: Override-set minimization — DONE 2026-08-12

- `src/ecosystems/npm/override-minimizer.js` — `minimizeOverrides()` iteratively simulates removal of each flat-string override via temp npm install; keeps only those still needed.
- `simulator.js` — added `simulatePackage(pkgObject, lockPath, opts)` export (takes a raw pkg object, not base+candidates).
- `mendfix cleanup --simulate` flag activates simulation path; `--max-simulations` also honored.
- 15 new tests in `tests/ecosystems/npm/override-minimizer.test.js` (simulator mocked).

### ✅ Step V2-14: Whole-graph before/after diff — DONE 2026-08-12

- `src/core/graph-diff.js` — `captureGraph(lockFilePath)` → `Map<name, string[]>`, `diffGraphs(before, after)` → `{added, removed, changed, unchangedCount}`, `formatDiff(diff, meta)` → markdown.
- Wired into `writeOutputNpm` in `mendfix.js`: captures lock state before install; after successful install diffs and writes `graph-diff.md` to `--out-dir`.
- 13 new tests in `tests/core/graph-diff.test.js`.
- 134/134 tests pass; baseline A:5 B:0 C:3 confirmed.

---

## Phase 5 — Multi-repo Portfolio Mode ✅ COMPLETE 2026-08-12

**`mendfix portfolio --config portfolio.json`** — analyze vulnerabilities across multiple repos in one run.

| Component | File | Status |
|-----------|------|--------|
| Portfolio orchestrator | `portfolio-runner.js` (root) | ✅ |
| Portfolio report generator | `src/core/portfolio-report.js` | ✅ |
| CLI subcommand `mendfix portfolio` | `mendfix.js` | ✅ |
| 25 runner tests | `tests/core/portfolio-runner.test.js` | ✅ |
| 20 report tests | `tests/core/portfolio-report.test.js` | ✅ |

332/332 tests pass. Baseline A:5 B:0 C:3 confirmed.

**Config format:**
```json
{
  "repos": [
    { "name": "org/repo", "report": "./vuln.json", "ecosystem": "npm", "lockFile": "./package-lock.json" }
  ],
  "outDir": "./portfolio-output",
  "verifyVersions": false
}
```

**Output:** `portfolio-output/portfolio-report.md` + per-repo `remediation-report.md` in `portfolio-output/<repo-name>/`.

All 9 providers complete: Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy, GitLab, Xray.

---

## Phase 5.5 — Enterprise Trust and Pilot Release

### Mission 1 — Security and canonical-engine closure ← CURRENT

**Objective:** Make CLI, UI, portfolio and future CI integrations consume one canonical decision pipeline; remove product-security weaknesses before any external pilot.

#### ~~M1.1 Secure process execution~~ ✅ DONE 2026-08-21
- `src/core/safe-exec.js` — `ALLOWED_EXECUTABLES`, `resolveExecutable` (Windows .cmd), `validatePackageName`/`validateVersion`/`validatePath`, `safeSpawn` (no shell, structured result), `buildSafeEnv`
- Fixed critical shell injection in `rust/installer.js`, `rust/simulator.js`, `python/installer.js`, `python/simulator.js`
- Removed `shell: true` from `npm/installer.js`, `npm/simulator.js`, `maven/dep-tree.js`
- 41 new injection tests; **373/373 passing**; baseline A:5 B:0 C:3 confirmed

#### M1.2 Credential handling
- Stop accepting tokens as plain CLI arguments (deprecation warning if kept for compat)
- Prefer env injection, VS Code SecretStorage, short-lived platform credentials
- Never include credentials in reports, evidence, errors, process output, or PR descriptions
- Ensure extension actually uses SecretStorage before claiming it does

#### M1.3 Canonical orchestration API
- Create one canonical orchestration layer consumed by: CLI analyze, CLI apply, portfolio mode, VS Code analysis, future CI integrations
- **Confirmed gap:** `packages/vscode-extension/panel.js` calls `applyPhases(plan, null)` and stops — no lock-tree loading, no `enrichWithConfidence`, no `enrichWithPaths`
- Pipeline must include: provider detection → ecosystem detection → lock/dep-graph loading → deterministic resolution → phase classification → confidence enrichment → remediation-path exploration → security delta + blast radius → policy evaluation → structured result
- CLI and UI must not independently reimplement this pipeline
- Add contract tests comparing results across entry points

#### M1.4 Product threat model
- `docs/THREAT_MODEL.md` and `docs/SECURITY_ARCHITECTURE.md`
- Data-flow diagram, trust-boundary diagram, threats/mitigations, residual risks

#### M1.5 Reproducible clean CI
- Clean checkout: deterministic install → syntax check → all tests → regression fixture → machine-readable results
- No real secrets. No external repo changes. Least-privilege permissions.

#### M1.6 Documentation reconciliation
- Remove contradictory status across CLAUDE.md, CODEBASE.md, NEXT_MISSION.md, Master_Roadmap.md, docs/ROADMAP.md
- Keep completed/pending/blocker states precise

**Exit gate:** Test suite passes · regression baseline A:5 B:0 C:3 · identical fixtures produce equivalent decisions through CLI + UI adapter + portfolio adapter · no report-derived value interpolated into shell command · credential-redaction tests pass · all status docs agree.

---

### Mission 2 — Verified remediation evidence

Begin only after Mission 1 exit gate passes.

**Objective:** Phase A fix becomes reproducible and independently auditable.

- M2.1: Configurable build/test verification commands (safe process utility; required-check failure blocks Phase A)
- M2.2: Post-remediation rescan adapter (RESOLVED_AND_RESCANNED / RESOLVED_NOT_RESCANNED / INSTALL_VERIFIED_ONLY / VERIFICATION_FAILED)
- M2.3: Fail-closed safety gate (Phase A application fails or downgrades when required evidence is incomplete)
- M2.4: Canonical evidence model (versioned machine-readable JSON; SARIF + CycloneDX/VEX export; human report = view of canonical evidence)
- M2.5: Outcome taxonomy (FIXED / NOT_AFFECTED / MITIGATED / PATCHED / FORKED / ACCEPTED_RISK / LICENSE_BLOCKED / VERIFICATION_FAILED / REQUIRES_MIGRATION / NO_SAFE_PATH)
- M2.6: Benchmark corpus using synthetic/approved fixtures; measured metrics only — no fabricated percentages

**Exit gate:** Every verified Phase A fixture has a complete canonical evidence bundle · required failures downgrade/block · benchmark metrics reproducible.

---

### (interleaved) Phase 5.6 D1A — Exposure classification

Begin after Mission 2 exit gate. Feeds into Mission 3 KPI reports.

Classify vulnerable packages as: RUNTIME_REACHABLE / PRODUCTION_BUNDLED / BUILD_TIME_EXECUTED / CI_EXECUTED / TEST_ONLY / LOCAL_TOOLING_ONLY / INSTALLED_NOT_USED / NOT_IN_PRODUCTION_ARTIFACT / UNKNOWN_EXPOSURE

Evidence sources: lockfile dep flags · root dep classification · import/require usage · build config · lifecycle scripts · bundled production artifacts · CI scripts · dep path

Rules:
- devDependency flag alone never implies "not critical" — build/CI deps can execute with powerful credentials
- Preserve original vulnerability severity; add environmental exposure and remediation priority separately
- Exposure claims include evidence and confidence

**Exit gate:** Exposure data integrated into canonical evidence model · KPI reports include exposure breakdown · dev-only packages not incorrectly dismissed.

---

### Mission 3 — Paid-pilot delivery

Begin only after Mission 2 + D1A exit gates pass.

**Objective:** Package the engine for a controlled enterprise pilot with exposure-aware KPIs.

- M3.1: CI integrations — GitHub Actions (primary); Azure DevOps if capacity permits; least-privilege; dry-run default; dedicated branch; no protected-branch writes; evidence as artifact
- M3.2: Repository policy file (`.dependency-intelligence.yml` or equivalent) — allowed phases, severity threshold, blast-radius limit, build/test/rescan commands, registry allowlist, package denylist, freeze windows
- M3.3: Append-only structured audit trail
- M3.4: Pilot KPI report — findings analyzed/remediated, build/test pass rate, rescan closure rate, RUNTIME_REACHABLE exposure delta, engineer time estimate, PR acceptance
- M3.5: Pilot runbook

**Exit gate:** Pilot infrastructure passes synthetic/local integration tests · end-to-end: scan → plan → apply → build/test → rescan → evidence → draft PR (no real mutation) · policy and approval gates enforced · real pilot execution blocked on external repo supply.

---

## Phase 5.6 — Deep Remediation Intelligence (after M3)

### D1B — Removal, retirement and preventive hygiene
- Unused dependency detection (with evidence + confidence; no silent removal)
- Dependency retirement signals (deprecation, archived repo, maintenance history, maintainer concentration, license risk)
- Preventive hygiene: same-major patch/minor updates, deprecated packages, high-centrality deps, git/branch deps, runtime incompatibilities
- Preventive changes use separate PRs; default to recommendation not auto-application

### D2.1–D2.3 — Replacement and Major Migration Navigator
- D2.1: API usage fingerprint (imports, symbols, constructor usage, error handling, test patterns)
- D2.2: Alternative-package intelligence (curated catalogue, org-approved packages, native APIs; scored on capability coverage, security history, migration effort, license, runtime compat)
- D2.3: Migration strategy comparison (direct upgrade / major-by-major / adapter / strangler / dual-run / internal fork / feature removal)
- Generates `major-migration-plan.md` from canonical migration evidence

### D2.4 — Prototype branches (stretch goal)
Implement only after D2.1–D2.3 pass exit gate. Where policy permits: isolated prototypes, build/test comparison, dependency graph diff, behavioral replay. Do not merge or publish prototypes automatically. **This is a stretch goal, not a D2 gate condition.**

### D3 — Patch, Backport and Upstream Contribution
- D3.1: Native npm patch support (version-specific unified diffs, patch hashes in evidence)
- D3.2: Fix Transplant Engine (upstream fix commit location, smallest legal backport, regression tests)
- D3.3: Internal fork workflow (scoped private package, fork-debt ledger with owner + expiry)
- D3.4: LLM-assisted candidate patches — feature-flag disabled by default; no effect on Phase A/B/C classification; human security approval required; outcome labelled LLM_SYNTHESIZED_PATCH; never auto-publish
- D3.5: Licensing gate (detect/check license before patching/forking; LICENSE_BLOCKED outcome)
- D3.6: Upstream disclosure preparation (never sends externally without explicit approval)

---

## Phase 6 — Focused UI Layer (after 5.5 + 5.6 D1/D2)

Build on canonical orchestration API (M1.3) and exposure classification (D1A). The VS Code extension panel.js gap (calling applyPhases without lock-tree, confidence, or path enrichment) is resolved by M1.3.

Priorities:
1. VS Code extension rebuilt as thin client over canonical API
2. Read-only evidence and analysis view
3. Governed apply/approval workflow
4. Portfolio/pilot KPI view with exposure breakdown

Tauri and Chrome extension deferred until paid-pilot evidence shows demand.

---

## What NOT to do

- No TypeScript, build steps, or frameworks — ever
- No AI in the SemVer engine — it must stay deterministic
- No `@^major` selectors in overrides output
- No MAJOR_BUMP auto-applied — always Phase C
- Phase C must never become auto-apply merely because an LLM recommends a fix
- No fabricated pilot, benchmark or remediation-success results
- Do not build Tauri, Electron or Chrome extensions in these phases
- The VS Code extension must remain a thin client over the canonical engine

---

## Product context (one paragraph)

This is Phase 5.5 of a 9-phase Dependency Intelligence OS (see `Master_Roadmap.md`). The provider/core/ecosystem separation built in Phases 1–5 is permanent infrastructure. Phase 5.5 adds the enterprise trust layer: security hardening, canonical orchestration API, verified evidence model, and pilot delivery. Phase 5.6 adds deep remediation intelligence (exposure classification, migration navigator, patch/backport). The deterministic engine is and remains the MOAT. AI assists only after deterministic resolution, verification, and human approval are in place.
