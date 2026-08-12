# Remediation Capability Roadmap

**Source:** Synthesized from `NEXT_LEVEL_REMEDIATION_CAPABILITIES/CLAUDE_DEPENDENCY_REMEDIATION.md`
and `NEXT_LEVEL_REMEDIATION_CAPABILITIES/Remediation Capability Gap Analysis.md`, cross-referenced
against the current codebase as of 2026-08-12.

**Last updated:** 2026-08-12

---

## 1. Executive Summary

### What the engine can already do

The current engine (Phase 1, V1-ready) deterministically resolves ~90–95% of real CVEs via:

- **Phase A** — same-major safe upgrades; single lockfile version; full auto-apply
- **Phase B** — same-major multi-version conflicts; nested parent-scoped overrides; human review first
- **Phase C** — MAJOR_BUMP / NO_FIX / multi-major conflict; structured manual-review.md output
- **npm overrides** fully implemented: consumer range validation, Phase A→B downgrade, stale cleanup, Phase B→A promotion
- **Maven** pom.xml dependencyManagement patches + dep-tree parsing
- **Rollback** on install failure; idempotency via `.mend-manifest.json`
- **Renovate** output: renovate-builder, renovate-classifier, renovate-report, renovate-apply-report
- **Two-level parent upgrade exploration** (static SemVer inference only — not yet simulation-verified)
- **Confidence metadata** per resolution item (evidence + alternative fields)

### What the biggest missing capability is

**Verified remediation path exploration.**

The current engine classifies packages by SemVer rules and applies the result. It does not yet:
- Fetch candidate parent manifests from the registry to check what child range they introduce
- Simulate `npm install --package-lock-only` for each candidate and inspect the resulting lockfile
- Confirm the vulnerable dep actually resolves to the fixed version (not just infer it)
- Discover and compare multiple alternative paths before recommending one
- Recurse beyond two levels with safety guardrails

Until simulation is in place, all parent upgrade recommendations are INFERRED, not VERIFIED.
That is the single most important gap between the current engine and a production-grade
dependency remediation engine.

---

## 2. Core Architectural Principle

### Find → Explore → Simulate → Verify → Compare → Recommend → Apply

NOT: **Classify → Apply** (what the current engine does)

```
Vulnerable finding (LibraryEntry[])
          ↓
    EXPLORE candidate remediation paths
    (direct / parent upgrade / grandparent / override)
          ↓
    SIMULATE npm install --package-lock-only
    for each viable candidate
          ↓
    VERIFY lockfile → is vulnerable dep resolved to fixed version?
          ↓
    CHECK for newly introduced vulnerabilities / peer conflicts
          ↓
    COMPARE all VERIFIED paths
          ↓
    RECOMMEND minimum-change / lowest-risk verified path
          ↓
    CLASSIFY → Phase A/B/C + decision label (label is output of evidence, not driver)
          ↓
    APPLY write changes + install + validate
```

**Classification is a label on a verified remediation path, not a gate that drives which path to take.**

### Deterministic First

Use in priority order:
1. Dependency graph analysis
2. SemVer constraint checking
3. Registry metadata (versions, manifests)
4. Package-manager simulation (lockfile resolution)
5. Static analysis (reachability, scopes)
6. Reproducible verification (lockfile inspection, test runs)

LLM/AI only after deterministic capabilities are exhausted. AI assists — it never replaces
deterministic resolution.

---

## 3. The Canonical Example

This scenario must be discoverable and verified automatically by the engine.

```
z
└── y@1.5.0
    └── x@^1.2.0

x@1.2.0 = vulnerable
x@2.2.0 = fixed   (MAJOR_BUMP — direct override is high-risk)

y@1.6.0
└── x@^2.1.0      ← y@1.6.0 naturally brings x into the fixed major

z declares: y "^1.5.0"   ← y@1.6.0 satisfies this
```

**What the engine must do (12 steps):**

1. Detect x@1.2.0 is vulnerable; direct upgrade to x@2.2.0 is MAJOR_BUMP
2. Identify y as the blocking parent — it holds x to `^1.x`
3. Read z's declared range for y: `^1.5.0`
4. Query npm registry for all y versions satisfying `^1.5.0` → discovers y@1.5.0, y@1.6.0
5. Fetch y@1.6.0 `package.json` manifest from registry → reads `"x": "^2.1.0"`
6. SemVer-check: does x@2.2.0 satisfy `^2.1.0`? → YES
7. **Run isolated simulation**: write temp `package.json` with y@"1.6.0", run `npm install --package-lock-only --legacy-peer-deps` in a temp directory
8. **Inspect resulting lockfile**: confirm x resolves to 2.2.0 (or ≥ 2.2.0)
9. Check simulated graph for new vulnerabilities from the current findings set
10. Classify path as `SAFE_PARENT_UPGRADE` with confidence = VERIFIED
11. Compare against alternative: direct override of x to 2.2.0 → `CONTROLLED_OVERRIDE` (INFERRED)
12. Recommend: upgrade y@1.5.0 → y@1.6.0 (minimum-change verified path over forcing an untested override)

**Static SemVer inference alone is insufficient for VERIFIED classification.** Steps 7–8
(simulation + lockfile inspection) are mandatory to promote from INFERRED → VERIFIED.

---

## 4. Decision Label Taxonomy

These six labels come from `CLAUDE_DEPENDENCY_REMEDIATION.md`. They are an **output enrichment
layer** — assigned after exploration/simulation provides evidence. They do not drive which path
to explore. They replace the raw Phase A/B/C label in reports with human-readable intent.

| Label | Maps to | Meaning |
|-------|---------|---------|
| `SAFE_ALIGNED` | Phase A | Fixed version satisfies all consumer ranges; natural resolution; no override needed |
| `SAFE_PARENT_UPGRADE` | Phase A/B | Parent upgrade brings fixed child naturally; preferred over override |
| `CONTROLLED_OVERRIDE` | Phase B | Override required; parent upgrade not practical or unavailable; justified and documented |
| `NOT_FIXABLE` | Phase C (NO_FIX) | No safe version exists; no upgrade path found |
| `NON_RUNTIME_EXPOSURE` | Phase C (dev chain) | Vulnerable package is not reachable in production runtime |
| `MANUAL_SECURITY_REVIEW` | Phase C (MAJOR_BUMP, multi-major) | Upgrade requires major-version change or manual compatibility assessment |

**Confidence levels** (from `CLAUDE_DEPENDENCY_REMEDIATION.md`):

| Confidence | When assigned |
|-----------|---------------|
| `VERIFIED` | Simulation run + lockfile confirmed fixed version resolves |
| `INFERRED` | SemVer inference only; simulation not run (timeout, limit, or not yet built) |
| `MANUAL` | Cannot determine automatically; requires human investigation |

Never assign VERIFIED to an untested override.

---

## 5. Change Budget Principle

From `CLAUDE_DEPENDENCY_REMEDIATION.md` — used to rank among valid remediation paths.
Prefer smallest justified change that fully resolves the vulnerability.

**Ranking order (lowest blast radius first):**

1. Lockfile-only resolution (npm re-resolves naturally without `package.json` change)
2. Direct dep version constraint relaxation (widen `^x.y.z` to let npm pick fixed)
3. Parent patch/minor upgrade (same major, new minor or patch)
4. Parent minor upgrade (within same major)
5. Parent major upgrade (cross-major; highest risk)
6. Single targeted override (child pinned; justified)
7. Multiple overrides (last resort)

Within each tier, prefer the smallest SemVer distance from current version.

---

## 6. Safety Gate Before Editing

From `CLAUDE_DEPENDENCY_REMEDIATION.md` — a required internal checklist before any write.

```
Finding:           <CVE + severity>
Dependency path:   root → Y → X
Current:           X@1.2.0
Fixed:             X@2.2.0
Parent range:      Y declares X@^1.2.0
Alignment:         NOT SATISFIED (^1 cannot reach 2.x)
Parent candidate:  Y@1.6.0 (satisfies Z's ^1.5.0 constraint)
Candidate range:   Y@1.6.0 declares X@^2.1.0
Simulation:        VERIFIED — lockfile shows X@2.2.0
Runtime class:     RUNTIME
Decision:          SAFE_PARENT_UPGRADE
Confidence:        VERIFIED
Risk:              Y minor upgrade; peer dep conflicts: none detected
Validation:        npm ls x --all confirms 2.2.0; no new CVEs introduced
```

Stop for human approval when:
- Confidence = MANUAL
- Any MAJOR_BUMP in the recommended path
- Peer dependency conflicts detected in simulation

Auto-proceed when:
- Confidence = VERIFIED and label = SAFE_ALIGNED or SAFE_PARENT_UPGRADE (minor)
- No peer conflicts
- No new vulnerabilities introduced

---

## 7. Guardrails for Recursive Parent-Chain Exploration

These must be implemented together with the recursive explorer to keep it safe and deterministic.

| Guardrail | Default | Purpose |
|-----------|---------|---------|
| **Cycle detection** | — | Track visited `(package, version)` pairs; abort branch if revisited |
| **Depth limit** | 5 levels | Prevents unbounded recursion on deep chains |
| **Candidate limit per level** | 10 versions | Cap versions inspected per parent; prune by SemVer proximity first |
| **Simulation limit** | 20 per run | `npm install` is expensive; cap total simulations per CVE resolution |
| **Per-simulation timeout** | 30s | Fail-open on timeout: demote to INFERRED, never block the run |
| **Registry/manifest cache** | per run | Cache `GET /package@version` responses; avoid redundant network calls |
| **Simulation cache** | `hash(package.json state)` → lockfile | Avoid re-simulating identical `package.json` states |
| **Duplicate graph-state detection** | — | If two branches reach same `(pkg, version)` set, collapse to one |
| **Deterministic candidate ordering** | semver descending | Sort candidates before iterating; ensures reproducible output |

All limits must be configurable via CLI flag (`--max-depth`, `--max-simulations`, etc.) and
must fail-open: when a limit is hit, demote confidence to INFERRED rather than returning an error.

---

## 8. Current Capability Matrix

### Fully Implemented

| Capability | File(s) | Notes |
|-----------|---------|-------|
| Direct compatible dep remediation (Phase A) | `src/core/semver-engine.js`, `src/core/phases.js` | Same-major safe fix; consumer range validation; auto-apply |
| Exact-version pin / consumer range mismatch | `src/ecosystems/npm/lock-parser.js`, `phases.js` | Phase A→B downgrade when range not satisfied |
| Minimal-change SemVer selection | `src/core/semver-engine.js` | Per-CVE min same-major fix → max across CVEs |
| Override minimization / stale cleanup | `src/ecosystems/npm/overrides.js`, `mendfix cleanup` | Stale detection + removal; Phase B→A promotion |
| Dev/build all-dev false positive | `src/core/phases.js` | `probableFalsePositive` when ALL lock entries are dev |
| Cross-tool provider architecture | `src/providers/index.js`, `mend.js`, `github.js` | Auto-detect; LibraryEntry[] canonical model |
| npm ecosystem (full) | `src/ecosystems/npm/` | lock-parser, overrides, installer, registry |
| Maven ecosystem (partial) | `src/ecosystems/maven/` | pom-writer, dep-tree, registry |
| Ecosystem-neutral remediation model | `src/providers/`, `src/core/`, `src/ecosystems/` | provider/core/ecosystem separation; zero cross-imports |
| Remediation explanation (partial) | `src/core/confidence.js`, `manual-review.md`, `CLAUDE_WORKFLOW.md` | WHY-focused logging; confidence evidence + alternative |
| Rollback on install failure | `src/ecosystems/npm/installer.js` | `snapshotFiles`/`restoreFiles` |
| Idempotency pre-flight | `mendfix.js` + `.mend-manifest.json` | Skip already-applied overrides |
| Confidence metadata | `src/core/confidence.js` | evidence + alternative fields per item |
| Renovate integration | `src/core/renovate-builder.js`, `renovate-classifier.js`, `renovate-report.js`, `renovate-apply-report.js` | Full Renovate config generation + PR output |
| PR description generation | `src/core/pr-description.js` | Written 2026-08-12 |
| Git commits (written, not yet wired) | `src/core/git-commits.js` | `commitPhaseA`/`commitPhaseBC` ready; needs `--commit` flag in mendfix.js |

### Partially Implemented

| Capability | What Exists | What's Missing |
|-----------|------------|---------------|
| Parent upgrade exploration | `src/ecosystems/npm/parent-upgrade-explorer.js` — 2-level, static SemVer | Manifest inspection per candidate; **lockfile simulation**; security verification; multi-path comparison |
| Recursive parent-chain | 2-level in parent-upgrade-explorer.js | Full recursion with all 9 guardrails |
| Mixed dev/runtime classification | all-dev check only | Mixed chains (prod + dev path to same package) |
| Dependency purpose classification | dev/runtime binary | test, lint, docs, storybook, CLI, optional |
| Upstream remediation discovery | partially via parent explorer | Explicit "upstream already released compatible fix" surface in output |
| "Why isn't Renovate fixing this?" | Renovate files exist | Explanation of blocking reason in output |
| Renovate PR relationship analysis | builder/classifier/report exist | PR redundancy detection, PR conflict detection, ordering |

### Not Implemented

| # | Capability | Priority | Value | Complexity | Phase |
|---|-----------|----------|-------|-----------|-------|
| — | Isolated package-manager simulation | P0 | HIGH | HIGH | V1.x |
| — | Manifest inspection per candidate version | P0 | HIGH | MEDIUM | V1.x |
| — | Multi-path comparison + Change Budget ranking | P1 | HIGH | MEDIUM | V1.x |
| 12 | Dependency blast radius | P1 | HIGH | MEDIUM | V1.x |
| — | Safety Gate pre-edit checklist | P1 | HIGH | LOW | V1.x |
| — | Decision label taxonomy (output layer) | P1 | HIGH | LOW | V1.x |
| 8 | Override-set minimization | P2 | MEDIUM | MEDIUM | V2 |
| 10 | Whole-graph remediation impact (before/after diff) | P2 | HIGH | HIGH | V2 |
| 11 | Security delta (CVEs fixed vs introduced) | P2 | HIGH | MEDIUM | V2 |
| 20 | Remediation scoring (multi-factor, explainable) | P2 | MEDIUM | HIGH | V2 |
| 19 | Remediation portfolio optimization | P3 | HIGH | VERY HIGH | V3 |
| 16 | Dependency health (deprecated, release activity) | P3 | MEDIUM | MEDIUM | V4 |
| 21 | Regression-aware remediation (historical outcomes) | P3 | HIGH | HIGH | V4 |
| 22 | Organization-specific knowledge base | P3 | HIGH | VERY HIGH | V4 |
| 26 | Replacement/removal remediation | P3 | MEDIUM | HIGH | future |

---

## 9. V1 Completion — Remaining Gaps

These are blocking or nearly-blocking before V1 is declared complete.

### Gap 1: Wire git-commits.js into mendfix.js apply

`src/core/git-commits.js` is written and exports `commitPhaseA`, `commitPhaseBC`, `commitFalsePositives`.
Not yet called from `mendfix.js apply`.

- Add `--commit` flag to `mendfix apply`
- After Phase A applied + install succeeds → call `commitPhaseA(projectDir, phaseAItems, ecosystem)`
- Phase B/C commit opt-in after human review

### Gap 2: Confidence enrichment in mendfix CLI path

`confidence.js` fields (evidence, alternative) are present in the Renovate path but not wired into
the main `mendfix analyze/apply` output. Phase C items should carry full evidence context.

### Status of previously-listed gaps (as of 2026-08-12 SESSION_LOG)

| Item | Previous Status | Actual Status |
|------|----------------|---------------|
| Scenarios 15/16: git-commits.js wiring | Not wired | File written; wiring still needed in mendfix.js |
| Scenario 18: PR description | Not started | `src/core/pr-description.js` created |
| Maven dep-tree parser | Not started | `src/ecosystems/maven/dep-tree.js` created |
| Confidence enrichment in CLI path | Partial | Still only in Renovate path |

---

## 10. V1.x — Remediation Path Explorer

**This is the core differentiator.** Build the `Find → Explore → Simulate → Verify → Compare → Recommend → Apply` pipeline incrementally. Each step is independently valuable.

### Step A — Candidate parent version discovery

Extend `src/ecosystems/npm/parent-upgrade-explorer.js`:

- Given blocking parent Y at Yv, query all Y versions satisfying root's `^Yv` constraint (already partial)
- Apply candidate limit + deterministic (descending SemVer) ordering guardrail
- Return ordered candidate list for manifest inspection

### Step B — Manifest inspection per candidate

For each candidate Y@v:
- Fetch `Y@v/package.json` from npm registry (`/Y/v` endpoint)
- Extract declared range for vulnerable child X from `dependencies`
- SemVer-check: does fixed X@fv satisfy Y@v's declared range for X?
- Cache result per `(Y, v)` for the run

New file: `src/ecosystems/npm/registry.js` already handles version fetching — extend to
fetch full manifest. Or extend `parent-upgrade-explorer.js` directly.

Dependency: Step A (candidate list) + registry.js manifest endpoint.

### Step C — Isolated package-manager simulation

New file: `src/ecosystems/npm/simulator.js`

```
simulate(packageJsonPath, candidates) → SimulationResult[]

SimulationResult {
  candidate: { name, from, to },
  success: boolean,
  resolvedVersions: Map<pkgName, version>,  // from lockfile
  peerConflicts: string[],
  timedOut: boolean,
  error: string | null
}
```

Implementation:
1. Create temp directory
2. Copy `package.json` + `package-lock.json` into temp dir
3. Apply candidate version change to temp `package.json`
4. Run `npm install --package-lock-only --legacy-peer-deps` with timeout
5. Parse resulting `package-lock.json` using existing `lock-parser.js`
6. Return `resolvedVersions` map

Apply all guardrails:
- Timeout per simulation (default 30s via `child_process.execSync` timeout option)
- Simulation limit per run (track across calls; throw `SIMULATION_LIMIT_EXCEEDED`)
- Cache result by `hash(package.json)` → `SimulationResult`
- Clean up temp directory on completion or error

Dependency: Step B (manifest inspection to filter non-viable candidates before simulating).

### Step D — Security verification in simulated graph

After simulation, cross-reference simulated `resolvedVersions` against the current `LibraryEntry[]`
finding set:

- For each package in `resolvedVersions`: check if any entry in findings has the same name AND
  the simulated version is still in the vulnerable range
- Surface: `newVulnerabilitiesIntroduced[]`, `peerConflicts[]`, `existingVulnerabilitiesFixed[]`

This tells the recommendation engine: "This candidate fixes CVE-A but introduces CVE-B."

Dependency: Step C.

### Step E — Multi-path comparison + Change Budget ranking

Extend `src/core/phases.js` (or new `src/core/remediation-paths.js`):

- Collect all explored paths for each vulnerable package: `{ type, candidate, confidence, newVulns, peerConflicts }`
- Rank by:
  1. Confidence: VERIFIED > INFERRED
  2. Change Budget tier (Section 5 ordering)
  3. Minimum SemVer distance within tier
  4. Fewest new vulnerabilities introduced
- Emit top-ranked path as `recommendedPath`; emit all alternatives as `alternativePaths[]`

Dependency: Steps C + D.

### Step F — Classification last

After Step E produces the recommended path:
- Assign Phase A/B/C based on path type and confidence
- Assign decision label (Section 4) based on path type
- This is purely a label on already-determined evidence

### Step G — Recursive exploration with guardrails

If Y cannot be upgraded within Z's range → walk up to Z:
- Check Z's declared range for Y
- Query Z candidate versions
- For each Z candidate: fetch manifest, check Y range, simulate, verify
- Apply all 9 guardrails (Section 7)
- Stop when: fix found AND verified OR depth limit hit OR candidate limit exhausted

---

## 11. V1.x — Additional Enhancements

After Remediation Path Explorer core is in place:

### Dependency blast radius

Count how many packages depend on the vulnerable package (direct + transitive consumers). Break
down by production vs development consumers. Feed into the Change Budget ranking as a risk signal:
high blast radius → prefer parent upgrade over override; warrant more conservative candidate selection.

Implementation: extend `src/ecosystems/npm/lock-parser.js` to build reverse-dependency index.
Cost: LOW. Value: HIGH (feeds path ranking + human review output).

### Safety Gate pre-edit checklist

Before any write in `mendfix.js apply`: assemble the pre-edit plan (Section 6) and emit it at
`--verbose` level. For MANUAL confidence or MAJOR_BUMP in recommended path: print plan and halt,
requiring `--force` to proceed.

Implementation: new function in `src/core/report.js` or inline in `mendfix.js` apply block.

### Decision label taxonomy

Add `decisionLabel` field to `PhasedItem` output (alongside existing `phase`). Assign per
Section 4 mapping. Emit in `report.js`, `manual-review.md`, and `pr-description.js`.

Zero engine change — purely adds a named string field after classification.

### Mixed dev/runtime chain classification (Scenario 8 full)

Recursive parent chain walk: if every production path to the vulnerable package passes through
a `devDependencies` root, classify as `probableFalsePositive`. Currently fires only when ALL
lock entries are `dev: true`. This extension handles mixed chains.

Implementation: extend `src/core/phases.js` using the reverse-dependency index from blast radius.

### Renovate PR relationship analysis

On top of the existing Renovate integration (not a dependency of the core engine):
- Detect PRs that become redundant after another PR merges (e.g., PR1 upgrades Y which fixes X,
  making PR2 that directly upgrades X unnecessary)
- Group related PRs that affect the same dependency chain
- Surface PR ordering recommendations

Implementation: extend `src/core/renovate-classifier.js`.

---

## 12. V2 — Remediation Optimization

Build after Remediation Path Explorer is stable.

### Override-set minimization

For each current override: remove it, simulate `npm install --package-lock-only`, inspect
lockfile — if the secure version still resolves without the override, remove it permanently.
Iterate until no more overrides can be removed. Uses simulator.js.

### Whole-graph before/after diff

Before applying a remediation: capture `resolvedVersions` for the full dependency graph.
After applying: capture again. Emit a diff: packages added, removed, changed, version moves.

### Security delta

Given a candidate remediation, compute:
- Vulnerabilities fixed (CVEs that were in finding set, now resolved)
- Vulnerabilities introduced (new CVEs now present in simulated graph)
- Net delta: fixed − introduced

Use to rank candidates when multiple paths exist with similar Change Budget scores.

### Remediation scoring

Multi-factor scoring for each candidate path. Must remain explainable (no opaque weights).

Factors:
- SemVer distance (patch = 1, minor = 2, major = 3)
- Blast radius (packages changed in simulated graph)
- Override count (0 = best)
- Security delta score
- Peer conflict count
- Confidence tier (VERIFIED=0, INFERRED=1, MANUAL=2)
- Production reachability (RUNTIME < BUILD < CI)

Score = weighted sum with documented weights. Emit breakdown per candidate.

---

## 13. V3 — Universal Ecosystem & Tool Layer

### Additional providers (uses existing provider arch — no core changes)

| Provider | File | Status |
|----------|------|--------|
| Snyk | `src/providers/snyk.js` | Not started |
| Dependabot | `src/providers/dependabot.js` | Not started |
| npm audit | `src/providers/npm-audit.js` | Not started |
| OSV | `src/providers/osv.js` | Not started |
| GitHub Advisory | `src/providers/github-advisory.js` | Not started |

All implement `parse(filePath) → LibraryEntry[]`. Register in `src/providers/index.js`.

### Additional ecosystems

| Ecosystem | Required for parity with npm |
|-----------|------------------------------|
| Python (pip/poetry) | `src/ecosystems/python/` — lock-parser (poetry.lock / Pipfile.lock), registry (PyPI), pom-equivalent (pyproject.toml), simulator (pip install --dry-run) |
| Go (go.mod) | `src/ecosystems/go/` — lock-parser (go.sum), registry (pkg.go.dev), override-equivalent (replace directives) |
| .NET (NuGet) | `src/ecosystems/dotnet/` — lock-parser (packages.lock.json), registry (nuget.org), override-equivalent (version constraints) |
| Rust (Cargo) | `src/ecosystems/rust/` — lock-parser (Cargo.lock), registry (crates.io) |

Each ecosystem needs: lock-parser → DepTree, registry, simulator adapter, writer.

### Remediation portfolio optimization

Given N CVEs and M Renovate PRs: find the minimum set of dependency changes that resolves
the maximum number of CVEs. This is a set-cover optimization problem.

Inputs: `LibraryEntry[]` finding set, `VerifiedPath[]` from the remediation engine.
Output: recommended minimum change set with CVE coverage summary.

Complexity: VERY HIGH. Defer until simulation is mature and the path explorer is stable.

---

## 14. V4 — Dependency Knowledge Layer

Build after the deterministic engine is mature and covers multiple ecosystems.

### Regression-aware remediation

Store historical remediation outcomes:
```
{ package, fromVersion, toVersion, ecosystem, repository, success, failureReason, peerConflicts }
```
Query before recommending: "This upgrade pattern failed in 3 repos due to peer conflict with Z."
Architecture: local SQLite file (`~/.mend-autofixer/remediation-history.db`) or JSON append log.

### Organization-specific knowledge base

Same structure as regression store, but org-scoped. Shared across repos in the same org.
Identifies: common conflicts, repo-specific constraints, package-specific behavior patterns.
Architecture: organization config file checked into a central repo, or cloud-hosted endpoint.

### Dependency health signals

For registry-available packages: deprecated status, latest release date, release frequency,
open CVE count, maintenance activity (last commit, open issues). Feed into path ranking as
a tie-breaker: among two equally-scored candidates, prefer the more actively maintained one.

---

## 15. V5 — Intelligence Layer (LLM)

Corresponds to Phase 8 of `Master_Roadmap.md`. Only after V4 is stable.

LLM assists with — never replaces — deterministic resolution:

- **Changelog analysis**: parse upstream CHANGELOG / GitHub releases to assess breaking change risk
- **Ambiguous evidence interpretation**: when static analysis cannot determine runtime reachability, LLM reads source to classify
- **Upgrade risk prediction**: "Based on 40 similar upgrades, this pattern has a 15% peer conflict rate"
- **Organization pattern learning**: learn from org's historical remediation preferences
- **Natural language explanation**: explain complex multi-hop remediation in plain English for PRs

---

## 16. Renovate Integration — Preserved as Integration Layer

Renovate PR consolidation is **not** a core engine dependency. It consumes verified remediation
paths and translates them into Renovate config / PR groupings. Current files:
- `src/core/renovate-builder.js` — build Renovate config from remediation output
- `src/core/renovate-classifier.js` — classify findings for Renovate compatibility
- `src/core/renovate-report.js` — report generation
- `src/core/renovate-apply-report.js` — apply-phase reporting

Future PR relationship analysis (redundancy detection, PR ordering) enhances this layer.
Never treat it as a prerequisite for the core remediation engine.

---

## 17. Recommended Build Sequence

```
V1 Completion (now)
────────────────────────────────────────────────────────────
  1. Wire git-commits.js into mendfix.js apply (--commit flag)
  2. Wire confidence.js enrichment into mendfix CLI path

V1.x — Remediation Path Explorer (next 3 builds)
────────────────────────────────────────────────────────────
  3. Manifest inspection per candidate parent version
     → Extends parent-upgrade-explorer.js + registry.js
     → Pure registry work; no simulation yet
     → Prerequisite for everything below

  4. Isolated package-manager simulation (simulator.js)
     → npm install --package-lock-only in temp dir
     → Apply all 9 guardrails
     → Promotes INFERRED → VERIFIED
     → The canonical z→y→x scenario becomes automatically solved

  5. Multi-path comparison + Change Budget ranking
     → Collect all verified paths; rank by Change Budget tier
     → Emit recommendation + alternatives
     → Phase A/B/C + decision label assigned last, from evidence

V1.x — Enhancements (after core is stable)
────────────────────────────────────────────────────────────
  6. Security verification in simulated graph
     (detect new CVEs introduced by a candidate)

  7. Dependency blast radius
     (reverse-dependency index; feeds ranking)

  8. Safety Gate pre-edit checklist
     (structured evidence summary; MANUAL/MAJOR halt)

  9. Decision label taxonomy as output enrichment field

 10. Mixed dev/runtime chain classification (Scenario 8 full)

 11. Renovate PR relationship analysis

V2 — Remediation Optimization
────────────────────────────────────────────────────────────
 12. Recursive parent-chain exploration with full guardrails

 13. Override-set minimization

 14. Whole-graph before/after diff

 15. Security delta per candidate

 16. Remediation scoring (multi-factor, explainable)

V3 — Universal Layer
────────────────────────────────────────────────────────────
 17. Additional providers (Snyk, Dependabot, npm audit, OSV)

 18. Additional ecosystems (Python, Go, .NET, Rust)

 19. Remediation portfolio optimization

V4+ — Knowledge + Intelligence
────────────────────────────────────────────────────────────
 20. Regression-aware remediation store

 21. Organization-specific knowledge base

 22. Dependency health signals

 23. LLM intelligence layer (Phase 8 of Master_Roadmap.md)
```

---

## 18. Top 10 Next Capabilities

| Rank | Capability | One-line reason |
|------|-----------|----------------|
| 1 | **Manifest inspection per candidate parent version** | Prerequisite for simulation; pure deterministic registry work; immediately extends parent-upgrade-explorer.js |
| 2 | **Isolated package-manager simulation** | Converts INFERRED parent upgrade paths into VERIFIED; single highest-value correctness improvement |
| 3 | **Multi-path comparison + Change Budget ranking** | Selecting minimum-change verified path over first-possible-fix is the core remediation value proposition |
| 4 | **Security verification in simulated graph** | A candidate that fixes CVE-A but introduces CVE-B is not a valid recommendation |
| 5 | **Recursive parent-chain exploration (with guardrails)** | Extends 2-level explorer to multi-hop; needed for deep dependency graphs common in real repos |
| 6 | **Dependency blast radius** | Quantifies risk; feeds ranking; required for responsible auto-apply decisions |
| 7 | **Wire git-commits.js** (V1 completion) | Code already written; needed to close V1 |
| 8 | **Mixed dev/runtime chain classification** | Reduces false Phase C items; reduces manual review burden in real repos with mixed chains |
| 9 | **Safety Gate pre-edit checklist** | Prevents auto-apply on ambiguous cases; critical for production safety |
| 10 | **Decision label taxonomy** | Adds human-readable SAFE_ALIGNED/SAFE_PARENT_UPGRADE/CONTROLLED_OVERRIDE labels to output after simulation provides reliable evidence |

---

## 19. 3 Things to Build Next

These are the three highest-value capabilities after current V1 gaps close.

### 1. Manifest inspection per candidate parent version

**What:** For each candidate parent version, fetch its `package.json` from the npm registry
and extract the declared range for the vulnerable child. SemVer-check whether the fixed child
version satisfies the candidate's declared range.

**Why first:** Pure registry work; no simulation required; immediately makes parent upgrade
recommendations more accurate than static "query latest" inference; prerequisite for simulation.

**Files:**
- `src/ecosystems/npm/parent-upgrade-explorer.js` — add manifest fetch step after candidate discovery
- `src/ecosystems/npm/registry.js` — add `getManifest(name, version)` that fetches full `package.json`

**Interface change:**
```
// Before: returns { recommendedParentVersion: string }
// After:  returns { recommendedParentVersion: string, manifestVerified: boolean, childRangeInCandidate: string }
```

---

### 2. Isolated package-manager simulation (`src/ecosystems/npm/simulator.js`)

**What:** For each viable candidate parent version: write temp `package.json`, run
`npm install --package-lock-only --legacy-peer-deps` in a temp directory, parse resulting lockfile,
return whether vulnerable dep resolves to fixed version.

**Why second:** This is the step that converts "probably works" into "confirmed works". The
canonical z→y→x scenario becomes automatically solved and VERIFIED rather than INFERRED.

**New file:** `src/ecosystems/npm/simulator.js`

```js
// Returns SimulationResult[]
simulate(basePackageJsonPath, baseLockPath, candidates, options)

// SimulationResult shape:
{
  candidate: { name, from, to },
  success: boolean,
  resolvedVersions: Map<name, version>,
  peerConflicts: string[],
  timedOut: boolean
}
```

Apply all 9 guardrails (see Section 7). Fail-open on timeout/limit: return `{ timedOut: true }`.
Clean temp directories unconditionally (even on error).

---

### 3. Multi-path comparison + Change Budget ranking

**What:** Collect all explored paths (direct upgrade, parent upgrade at each level, override) for
each vulnerable package. Rank by: VERIFIED > INFERRED > MANUAL, then by Change Budget tier
(Section 5), then by minimum SemVer distance. Emit top-ranked path as `recommendedPath`; emit
alternatives as `alternativePaths[]`. Assign Phase A/B/C and decision label after ranking.

**Why third:** This completes the `Find → Explore → Simulate → Verify → Compare → Recommend`
pipeline. Without it, the engine stops at the first path it finds rather than selecting the safest one.

**Files:**
- New `src/core/remediation-paths.js` — `comparePaths(paths[]) → ranked PhasedItem`
- Extend `src/core/phases.js` — call `comparePaths` after exploration produces candidates
- Extend `src/core/report.js` — emit `alternativePaths` section in output

---

## Appendix: Source Document Relationship

| Concept | Source | Role in this roadmap |
|---------|--------|---------------------|
| 10-step workflow | CLAUDE_DEPENDENCY_REMEDIATION.md | Maps to Find→Explore→Simulate→Verify→Compare→Recommend→Apply pipeline |
| 6 decision labels | CLAUDE_DEPENDENCY_REMEDIATION.md | Output classification layer (Section 4); assigned last |
| Change Budget | CLAUDE_DEPENDENCY_REMEDIATION.md | Path ranking principle (Section 5) |
| Safety Gate | CLAUDE_DEPENDENCY_REMEDIATION.md | Pre-edit checklist (Section 6) |
| DEPENDENCY_REMEDIATION_REPORT.md | CLAUDE_DEPENDENCY_REMEDIATION.md | Future report format (V1.x) |
| 27-capability framework | Remediation Capability Gap Analysis.md | Capability matrix (Section 8) |
| Simulation / what-if (#9) | Gap Analysis | Core V1.x engine (Sections 10, Step C) |
| Whole-graph impact (#10) | Gap Analysis | V2 (Section 12) |
| Security delta (#11) | Gap Analysis | V2 (Section 12) |
| Blast radius (#12) | Gap Analysis | V1.x enhancement (Section 11) |
| Portfolio optimization (#19) | Gap Analysis | V3 (Section 13) |
| Scoring (#20) | Gap Analysis | V2 (Section 12) |
| Regression-aware (#21) | Gap Analysis | V4 (Section 14) |
| Org knowledge (#22) | Gap Analysis | V4 (Section 14) |
| Ecosystem expansion (#24) | Gap Analysis | V3 (Section 13) |
| Renovate PR relationship (#18) | Gap Analysis | Integration layer enhancement (Section 11, Section 16) |
