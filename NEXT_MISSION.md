# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-21 (post-Batch-4 strategic replan)

---

## Batch Session Plan

### Original batches 1–4: ✅ ALL COMPLETE (2026-08-21)

| Batch | Missions | Status |
|-------|----------|--------|
| **1** | M1.2 + M1.3 + M1.4 + M1.5 + M1.6 | ✅ DONE |
| **2** | M2 (all) + D1A | ✅ DONE |
| **3** | M3 (all) + D1B + D2.1–D2.3 | ✅ DONE |
| **4** | D3 (patch/backport) | ✅ DONE — 810/810 tests |

---

### Strategic replan — Demo-first approach

**The problem with proceeding straight to Phase 6 UI:**
The engine is complete and correct, but the value is invisible. A UI showing 8 toy CVEs loses the room in 30 seconds. The product needs a **proof-of-value moment** where the numbers are undeniable before the UI is built.

**The "wow" moment we are building toward:**
> A report walks in with 60–80 CVEs. Other tools (Snyk, Dependabot, Mend) suggest "upgrade these 18–20 direct deps" — many of which are major bumps with no safe path. Our tool auto-applies fixes for 50+ CVEs in one npm install (Phase A/B parent upgrades), produces migration plans with effort estimates for the remaining 15–20, and classifies 8–10 as test-only / not production-reachable. All with a full evidence trail per finding — SARIF, VEX, audit log, KPI report.

**Why the engine already does this** — but needs the demo corpus to prove it:
- Phase A: safe same-major overrides, auto-applied
- Phase B: parent upgrade paths that transitively close multiple CVEs per upgrade
- Phase C: migration plans with alternative package scoring and effort estimates
- D1A: exposure classification separates test-only from production-reachable findings
- Evidence model: every decision is auditable (SARIF + VEX export)
- The transitive-graph advantage: most scanners flag direct deps; we model the full lock tree and find parent upgrades that fix 10–15 CVEs with one version bump

---

### New batches 5A → 7: Demo corpus → Comparison narrative → UI

Start each batch only after the previous one's exit gate passes.

| Batch | Work | What it unlocks | ← CURRENT |
|-------|------|-----------------|-----------|
| **5A** | Demo corpus + `mendfix demo` command | Real numbers for everything downstream | **← NEXT** |
| **5B** | Comparison report module + enhanced output | The "before/after" narrative for the demo | After 5A |
| **6** | VS Code extension rebuild (4 demo panels) | One-click management demo | After 5B |
| **7** | Polish: PDF export, portfolio KPI view, SARIF import story | Enterprise procurement readiness | After 6 |

---

## Batch 5A — Demo Corpus + `mendfix demo` command ← CURRENT NEXT BATCH

**Objective:** Build the synthetic but realistic multi-ecosystem fixture set that makes all engine output credible and impressive. Everything in batches 5B–7 depends on the numbers this corpus produces.

### 5A.1 — Demo corpus: vulnerable project fixtures

**Location:** `fixtures/demo-corpus/`

Build one realistic project per ecosystem (start with npm, add Maven second):

**npm corpus — `fixtures/demo-corpus/npm/`**
- `package.json` — 15–20 direct dependencies; names match real packages; versions pinned to vulnerable ranges
- `package-lock.json` — fully resolved lock tree, 3 levels deep; vulnerable packages appear only as transitives (not in direct deps), so surface scanners miss them
- Design rules for the lock tree:
  - 4–5 "parent upgrade paths": upgrading one direct dep transitively bumps 8–12 vulnerable transitives to safe versions
  - 3–4 "Phase A only" entries: vulnerable transitive has a safe patch, parent already allows it — pure override
  - 2–3 "Phase C / MAJOR_BUMP" entries: no safe path without breaking change, needing migration plan
  - 5–6 "test-only chain" entries: vulnerable package only reachable via devDependencies chain — D1A classifies as TEST_ONLY or LOCAL_TOOLING_ONLY
  - 2–3 "probable false positive" entries: package version in lock file already includes the fix (probableFalsePositive flag)
- Target: 60–80 total CVEs across the tree; 10–12 distinct vulnerable packages; multiple CVEs per package is fine

**Multi-scanner fixture set — `fixtures/demo-corpus/reports/`**
- `mend-report.json` — Mend JSON format pointing at the npm corpus
- `snyk-report.json` — Snyk JSON format, same vulnerabilities
- `dependabot-report.json` — GitHub Dependabot alerts JSON format
- `osv-report.json` — OSV scanner format
- All four reports cover the SAME set of CVEs so the demo can say "works with every scanner you already have"
- Each report should reflect what the scanner actually surfaces — direct-dep scanners will only show a subset; our engine finds the full transitive picture

**Maven corpus — `fixtures/demo-corpus/maven/`** (second priority, after npm)
- `pom.xml` — 10–12 direct dependencies
- Target: 20–30 CVEs, mix of Phase A patches and Phase C major bumps

### 5A.2 — `mendfix demo` subcommand

**File:** `mendfix.js` — new `demo` subcommand

Behaviour:
1. Copies demo corpus to a temp working directory
2. Runs `runAnalysisPipeline` against the Mend report + npm corpus (default) or `--scanner snyk|dependabot|osv` flag to switch reports
3. Generates all output files to `./demo-output/`
4. Prints a summary banner showing: CVE count → Phase A auto-fixed → Phase B parent upgrades → Phase C plans → exposure breakdown
5. Optionally opens the VS Code extension panel if `--ui` flag is passed (wired in Batch 6)
6. Exit 0 always (demo mode never fails)

The banner should look roughly like:
```
╔══════════════════════════════════════════════════════════════╗
║  mend-autofixer  Demo Run — Mend report · npm ecosystem      ║
╠══════════════════════════════════════════════════════════════╣
║  Input:  72 CVEs across 11 packages                          ║
║  ────────────────────────────────────────────────────────── ║
║  ✅ Phase A  — 5 packages auto-fixed  (covers 41 CVEs)       ║
║  ⚠️  Phase B  — 3 packages via parent upgrade (18 CVEs)      ║
║  ❌ Phase C  — 3 packages need migration plan  (13 CVEs)     ║
║  ────────────────────────────────────────────────────────── ║
║  🔍 Exposure: 6 findings are test-only (not prod-reachable)  ║
║  📄 Output → ./demo-output/                                  ║
╚══════════════════════════════════════════════════════════════╝
```

**Exit gate for Batch 5A:**
- `mendfix demo` runs to completion with zero errors
- Phase A count ≥ 4, Phase B count ≥ 2, Phase C count ≥ 2 (proves all three paths trigger)
- D1A exposure classifier fires on ≥ 4 findings
- All 4 scanner reports produce equivalent phase distributions (same CVEs, same decisions)
- `npx jest --no-coverage` still passes (no regressions)

---

## Batch 5B — Comparison Report Module + Enhanced Output

**Objective:** Add the "before/after" narrative that makes the engine's advantage quantifiable and presentable.

### 5B.1 — `src/core/comparison-report.js`

Produces a side-by-side comparison between what a naive scanner surfaces and what the engine delivers.

Key function: `buildComparisonReport(scannerEntries, phasedPlan, exposureResults, opts?)`

Output shape:
```
{
  scannerSuggestions: { directUpgrades: N, majorBumps: N, noFix: N },
  engineOutcomes: {
    autoFixed: N,          // Phase A
    parentUpgrade: N,      // Phase B
    migrationPlan: N,      // Phase C
    testOnlyDismissed: N,  // D1A TEST_ONLY / LOCAL_TOOLING_ONLY
    falsePositives: N,     // probableFalsePositive
  },
  cveDelta: {
    totalInput: N,
    closedAutomatically: N,
    closedViaParentUpgrade: N,
    requiresAction: N,
    notProductionReachable: N,
  },
  narrative: string,   // human-readable one-paragraph summary
}
```

Written to `./demo-output/comparison-report.md` as a table. This is slide 2 of the management demo.

### 5B.2 — Enhanced remediation report

Extend `src/core/report.js` to include in every run (not just demo):
- Exposure summary table at the top (how many findings per exposure tier)
- Phase distribution with CVE counts (not just library counts)
- False-positive count with reason
- For Phase B items: show the parent upgrade path explicitly ("upgrading `webpack` 4→5 closes `loader-utils` CVE-2022-37601 + 3 others")
- For Phase C items: show the top-ranked migration alternative + effort estimate
- Footer: evidence trail note — "Full SARIF at `remediation-evidence.sarif`, VEX at `remediation.vex.json`"

### 5B.3 — `mendfix demo --compare` flag

Extends the demo banner to show the comparison against what a naive scanner (direct-dep-only) would suggest vs what the engine produces. The delta is the value proposition.

**Exit gate for Batch 5B:**
- `comparison-report.md` generated and numbers are non-fabricated (derived from actual pipeline output)
- Enhanced report contains exposure summary + Phase B parent upgrade explanations + Phase C migration summaries
- `npx jest --no-coverage` passes

---

## Batch 6 — VS Code Extension Rebuild (Demo-Ready, 4 Panels)

**Objective:** Thin client over canonical API. Demo-ready in 4 panels. No new logic in the extension — all decisions happen in `orchestrator.js`.

**Prerequisite:** Batch 5A must pass its exit gate (real numbers needed for panels to be impressive).

### Panel 1 — Scan (Input)
- File picker for vulnerability report (accepts all 9 scanner formats)
- Auto-detects format via `detectProvider`
- Shows: scanner name, CVE count, raw library list
- "Analyze" button enabled once report is loaded

### Panel 2 — Analyze (Engine Output)
- Calls `runAnalysisPipeline` via the extension's existing IPC bridge
- Shows: Phase A/B/C breakdown table with CVE counts
- Shows: exposure classification pie (runtime reachable / test-only / unknown)
- Shows: comparison report delta ("scanner suggested X, we found Y additional fixes")
- "Apply Phase A" button; "Export SARIF/VEX" button; "View Evidence" button per finding

### Panel 3 — Apply (Changes)
- Phase A only (Phase B/C require human review — governed workflow)
- Shows before/after graph diff (captureGraph output)
- Shows: packages changed, CVEs closed, time elapsed
- Rollback button (calls restoreFiles)
- Confirmation gate: "Apply N overrides closing M CVEs? Yes / No"

### Panel 4 — Evidence (Audit Trail)
- Per-finding evidence bundle viewer: CVEs, phase, outcome, exposure, verification status
- Download SARIF button
- Download VEX button
- Download KPI report button
- Audit trail viewer (append-only NDJSON log)

**What NOT to build in Batch 6:**
- No new business logic — extension is a view, engine is the brain
- No TypeScript, no bundler, no React — plain HTML/JS/CSS in the webview
- No direct network calls from the extension — everything goes through CLI/orchestrator
- No portfolio view yet (Batch 7)

**Exit gate for Batch 6:**
- All 4 panels render without errors against the demo corpus
- `mendfix demo --ui` opens the extension and auto-loads the demo-output
- Phase A apply works end-to-end from the panel (writes overrides, runs install, shows graph diff)
- SARIF and VEX export buttons produce valid files
- Extension pipeline gap confirmed closed (M1.3 already fixed; regression test in panel integration)

---

## Batch 7 — Enterprise Polish

**Objective:** Close the remaining gaps for enterprise procurement conversations.

### 7.1 — PDF / HTML export
- `mendfix report --format html` generates a self-contained HTML report (no external deps)
- Suitable for emailing to security team or attaching to a JIRA ticket
- Includes: comparison table, evidence per finding, KPI summary, exposure breakdown

### 7.2 — Portfolio KPI view in extension
- Extend Panel 2 to show multi-repo portfolio view when a `portfolio.json` config is present
- Aggregate CVE count, Phase A/B/C distribution, exposure breakdown across all repos
- This is the "org-wide dashboard" slide for executive demos

### 7.3 — SARIF import story (docs + demo script)
- Document the SARIF import path for: GitHub Code Scanning, Azure DevOps, Jira, Defect Dojo
- Demo script: "Run mendfix, import SARIF to GitHub Code Scanning, all findings appear with evidence"
- No new code needed — SARIF export already works; this is positioning and docs

### 7.4 — `mendfix demo --scanner <name>` full coverage
- Ensure demo works identically across all 4 scanner fixtures (Mend / Snyk / Dependabot / OSV)
- CI test that runs `mendfix demo --scanner <each>` and asserts phase counts are equivalent
- This proves the "works with every scanner you already have" claim with evidence

**Exit gate for Batch 7:**
- HTML report opens in browser with all sections populated
- Portfolio KPI panel shows aggregate numbers across ≥ 2 repos
- CI passes with all 4 scanner variants
- `npx jest --no-coverage` passes

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

#### ~~M1.2 Credential handling~~ ✅ DONE 2026-08-21
- `mendfix.js` + `renovate-apply.js`: deprecation warning to stderr when any `--*-token` CLI arg is used — tokens remain functional for backward compat but env vars are the documented path
- Extension `_handleApply` confirmed: spawns CLI only, never passes token args
- No credential leakage found in reports, PR descriptions, or safe-exec calls

#### ~~M1.3 Canonical orchestration API~~ ✅ DONE 2026-08-21
- New `orchestrator.js` (root level): `runAnalysisPipeline(opts)` — full pipeline: provider detection → ecosystem detection → dep-tree loading (all 6 ecosystems) → SemVer resolution → optional registry verification → phase classification → Phase-C registry escalation → npm rootParents/depChain enrichment → optional parent-upgrade exploration → `enrichWithConfidence` → `enrichWithPaths`
- **Extension gap fixed:** `packages/vscode-extension/panel.js` `_handleAnalyze` now calls `runAnalysisPipeline` (was calling `applyPhases(plan, null)` and stopping); `lockPath` now passed in analyze message
- `portfolio-runner.js` `analyzeRepo` refactored to use orchestrator (removed 14-line manual pipeline)
- Contract tests: `tests/integration/orchestrator-contract.test.js` — verifies orchestrator ≡ direct pipeline ≡ portfolio-runner for the same input; 16 new tests
- **389/389 tests passing**; baseline A:5 B:0 C:3 confirmed

#### ~~M1.4 Product threat model~~ ✅ DONE 2026-08-21
- `docs/THREAT_MODEL.md` — data-flow diagram, trust boundaries, 8-threat table, residual risks
- `docs/SECURITY_ARCHITECTURE.md` — layer security properties, safe-exec model, credential model, input validation, known gaps

#### ~~M1.5 Reproducible clean CI~~ ✅ DONE 2026-08-21
- `.github/workflows/ci.yml` — Node 20; npm ci; syntax check; jest --no-coverage; regression fixture skipped when absent; permissions: contents: read

#### ~~M1.6 Documentation reconciliation~~ ✅ DONE 2026-08-21
- CODEBASE.md updated with orchestrator.js entry and 389 test count
- NEXT_MISSION.md M1 items all marked done

**✅ MISSION 1 EXIT GATE PASSED** — 389/389 tests · A:5 B:0 C:3 baseline · identical decisions via orchestrator/CLI/portfolio · no shell injection via report values · credential deprecation warnings active · all status docs agree.

---

### Mission 2 — Verified remediation evidence

Begin only after Mission 1 exit gate passes.

**Objective:** Phase A fix becomes reproducible and independently auditable.

- M2.1: Configurable build/test verification commands (safe process utility; required-check failure blocks Phase A)
- M2.2: Post-remediation rescan adapter (RESOLVED_AND_RESCANNED / RESOLVED_NOT_RESCANNED / INSTALL_VERIFIED_ONLY / VERIFICATION_FAILED)
- M2.3: Fail-closed safety gate (Phase A application fails or downgrades when required evidence is incomplete)
- M2.4: Canonical evidence model (versioned machine-readable JSON; SARIF + CycloneDX/VEX export; human report = view of canonical evidence)
- M2.5: Outcome taxonomy (FIXED / NOT_AFFECTED / MITIGATED / PATCHED / FORKED / ACCEPTED_RISK / LICENSE_BLOCKED / VERIFICATION_FAILED / REQUIRES_MIGRATION / NO_SAFE_PATH)
- ~~M2.6: Benchmark corpus using synthetic/approved fixtures; measured metrics only — no fabricated percentages~~ ✅ DONE 2026-08-21

**✅ MISSION 2 EXIT GATE PASSED** — Every Phase A fixture has a complete canonical evidence bundle · required failures downgrade/block (M2.3 gate) · benchmark metrics reproducible (2 fixtures, determinism verified).

---

### ~~(interleaved) Phase 5.6 D1A — Exposure classification~~ ✅ DONE 2026-08-21

`src/core/exposure-classifier.js` — `classifyExposure(item, depTree, opts?)` + `classifyPlanExposure(plan, depTree, opts?)`
- 9-value EXPOSURE enum (already in evidence-model.js)
- Evidence sources: lockfile dev flags, root-parent isDev, dep-chain depth, package-name pattern tables (test/build/CI), optional package.json scripts scan
- devDependency flag alone never dismisses a finding
- Wired into orchestrator.js as step 10 (opt-in via `classifyExposure: true`)
- `mergeExposureClassification` round-trip tested in benchmark corpus

**✅ D1A EXIT GATE PASSED** — Exposure data integrated into canonical evidence model via `mergeExposureClassification` · dev-only packages correctly classified (not dismissed) · 28 unit tests + benchmark integration test.

---

### ~~Mission 3 — Paid-pilot delivery~~ ✅ DONE 2026-08-21

**Objective:** Package the engine for a controlled enterprise pilot with exposure-aware KPIs.

- ~~M3.1: CI integrations — GitHub Actions + Azure DevOps; least-privilege; dry-run default; dedicated branch; no protected-branch writes; evidence as artifact~~ ✅ `src/ci/github-actions.js`
- ~~M3.2: Repository policy file (`.dependency-intelligence.yml`)~~ ✅ `src/core/policy-loader.js`
- ~~M3.3: Append-only structured audit trail~~ ✅ `src/core/audit-trail.js`
- ~~M3.4: Pilot KPI report~~ ✅ `src/core/kpi-report.js`
- ~~M3.5: Pilot runbook~~ ✅ `docs/PILOT_RUNBOOK.md`

**✅ MISSION 3 EXIT GATE PASSED** — 698/698 tests · pilot infrastructure tested with synthetic fixtures · policy + approval gates enforced · audit trail append-only · KPI metrics derived from evidence (no fabricated numbers).

---

## Phase 5.6 — Deep Remediation Intelligence (after M3)

### ~~D1B — Removal, retirement and preventive hygiene~~ ✅ DONE 2026-08-21
- ~~Unused dependency detection~~ ✅ `src/core/hygiene-advisor.js` `detectUnusedDevDeps`
- ~~Dependency retirement signals~~ ✅ `detectRetirementSignals`
- ~~Preventive hygiene~~ ✅ `detectPreventiveUpgrades`, `detectGitAndBranchDeps`
- All findings: `autoApplicable = false`; evidence-backed; confidence-labelled; 20 tests

### ~~D2.1–D2.3 — Replacement and Major Migration Navigator~~ ✅ DONE 2026-08-21
- ~~D2.1: API usage fingerprint~~ ✅ `src/core/usage-fingerprint.js` — regex import/require/export scanner, symbol extraction, subpath detection, effort estimation; 22 tests
- ~~D2.2: Alternative-package intelligence~~ ✅ `src/core/migration-planner.js` `ALTERNATIVES_CATALOGUE` — curated catalogue, composite scoring (capability×0.35 + security×0.30 + effort×0.25 + license×0.10 + orgBonus)
- ~~D2.3: Migration strategy comparison~~ ✅ `selectStrategy` — 8 strategies (DIRECT_UPGRADE / MAJOR_BY_MAJOR / ADAPTER / STRANGLER_FIG / DUAL_RUN / INTERNAL_FORK / FEATURE_REMOVAL / REPLACEMENT); generates `major-migration-plan.md`; 18 tests

**✅ D1B + D2.1–D2.3 EXIT GATE PASSED** — 698/698 tests · all hygiene findings evidence-backed + not auto-applicable · migration plan covers Phase C items only · usage fingerprint drives effort estimates.

### D2.4 — Prototype branches (stretch goal)
Implement only after D2.1–D2.3 pass exit gate. Where policy permits: isolated prototypes, build/test comparison, dependency graph diff, behavioral replay. Do not merge or publish prototypes automatically. **This is a stretch goal, not a D2 gate condition.**

### ~~D3 — Patch, Backport and Upstream Contribution~~ ✅ DONE 2026-08-21
- ~~D3.1: Native npm patch support~~ ✅ `src/core/patch-engine.js` — SHA-256 hash per diff, apply/verify/write helpers, buildPatchEvidence → mergePatchData in evidence-model
- ~~D3.2: Fix Transplant Engine~~ ✅ `src/core/fix-transplant.js` — manifest-injected upstream locator, semver-distance backport assessor (BACKPORTABLE/RISKY/NOT_BACKPORTABLE), transplant plan
- ~~D3.3: Internal fork workflow~~ ✅ `src/core/fork-workflow.js` — scoped name derivation, expiry-aware ledger, fork-debt-ledger.md+json writer
- ~~D3.4: LLM-assisted patches~~ ✅ `src/core/llm-patch-advisor.js` — feature-flag off by default; invariants always safe; applyApproval; LLM_SYNTHESIZED_PATCH in OUTCOMES; never auto-publishes
- ~~D3.5: Licensing gate~~ ✅ `src/core/license-gate.js` — SPDX permissive/copyleft/policy classification; LICENSE_BLOCKED outcome
- ~~D3.6: Upstream disclosure preparation~~ ✅ `src/core/disclosure-prep.js` — requiresApproval/autoSend invariants; md+json output; never sends externally

**✅ D3 EXIT GATE PASSED** — 810/810 tests · A:5 B:0 C:3 baseline · all D3 modules have no network calls (manifest injected by caller) · LLM advisor feature-flag off by default · disclosure never auto-sends.

---

## What NOT to do

- No TypeScript, build steps, or frameworks — ever
- No AI in the SemVer engine — it must stay deterministic
- No `@^major` selectors in overrides output
- No MAJOR_BUMP auto-applied — always Phase C
- Phase C must never become auto-apply merely because an LLM recommends a fix
- No fabricated pilot, benchmark or remediation-success results — all numbers derived from real fixture runs
- Do not build Tauri, Electron or Chrome extensions in these phases
- The VS Code extension must remain a thin client over the canonical engine
- Do not build demo corpus numbers by hand — they must be produced by running the actual pipeline against real fixture files
- Do not skip Batch 5A to go straight to UI — the UI needs real numbers to be impressive

---

## The one-sentence pitch

> "Every other scanner tells you what's vulnerable. We tell you what to fix, fix most of it automatically, and give you an auditable evidence trail for everything it couldn't fix — in the time it takes the security team to read the first report."

This only lands if the demo corpus makes the numbers real. That is why Batch 5A comes before the UI.

---

## Product context

This is the demo-ready phase of a 9-phase Dependency Intelligence OS (see `Master_Roadmap.md`). Phases 1–5 built the universal provider/core/ecosystem infrastructure. Phase 5.5 added enterprise trust (security hardening, canonical orchestration, verified evidence, pilot delivery). Phase 5.6 added deep remediation intelligence (exposure classification, migration navigator, patch/backport). The engine is complete and correct. Batches 5A–7 make its value visible and undeniable. The deterministic engine is and remains the MOAT — AI assists only after deterministic resolution, verification, and human approval are in place.
