# Universal Dependency Engine — Feature Tracker

Tracks feature completion across all phases. See `NEXT_MISSION.md` for what to build next.

---

## Phase 1 — Mend Auto-Fixer (npm + Maven) ✅ Complete

| Feature | Notes |
|---------|-------|
| JSON + Excel report parsing | Groups by `library.keyUuid`; handles 3 `fixResolution` string formats + Maven GAV |
| SemVer engine | Deterministic: per-CVE min same-major fix → max across CVEs; MAJOR_BUMP / NO_FIX / SAFE |
| Phase A/B/C classification | A: same-major single version; B: same-major multi-instance; C: MAJOR_BUMP/NO_FIX/multi-major |
| npm registry verification | `--verify-versions`; adjusts to nearest available ≥ fix; `exists: null` = pass-through |
| Phase A auto-apply | `--package-json <path>` applies Phase A overrides; merges, never replaces |
| Output: phase-a/b-overrides.json | Clean `"pkg": "version"` — no `@^major` selectors |
| Output: manual-review.md | Phase C structured checklist with upgradeType-specific action items |
| Output: remediation-report.md | Full markdown report with all phases, dep chains, confidence |
| package-lock.json dep tree | v2/v3 flat packages map; parent tracking with declared ranges; blast radius |
| Consumer range validation | Phase A → B downgrade when consumer pinned range doesn't satisfy fix version |
| Dev/build classification | `probableFalsePositive: true` when all lock-file instances are `dev: true` |
| Parent upgrade recommendations | Phase C MAJOR_BUMP items gain `rootParents[]` |
| Stale override cleanup | `mendfix cleanup`; flags/removes overrides where consumer ranges already cover fix |
| Nested parent-scoped overrides | Multi-major disjoint parents → Phase B with nested override map |
| Dependency chain display | Phase C items show `root → ... → vulnerablePkg` path via BFS |
| Phase B → A promotion | Same-major multi-instance Phase B auto-promoted when all consumer ranges satisfied |
| Direct dep detection + priority | Direct deps bump `dependencies`/`devDependencies`; transitive → `overrides` |
| package-lock.json update + verify | `runPackageLockUpdate` + `verifyFixVersions` in installer.js |
| Rollback on install failure | `snapshotFiles` / `restoreFiles` in installer.js |
| Preserve human changes | `.mend-manifest.json` — skips manually-edited overrides with warning |
| Maven support | maven/registry.js + pom-writer.js + dep-tree.js; auto-detects MAVEN_ARTIFACT |
| mendfix.js subcommands | analyze / apply / cleanup / renovate; mend-fix.js kept as shim |
| Idempotency pre-flight | Pre-flight check against .mend-manifest.json before any writes |
| Confidence metadata (Scenario 14) | confidence.js — evidence + alternative fields per resolution item |
| git-commits.js wiring (Scenarios 15/16) | `--commit` flag; commitPhaseA after successful install |
| PR description (Scenario 18) | pr-description.md written to outDir on every non-dry-run apply |

---

## Phase 1.x — Remediation Path Explorer ✅ Complete

| Feature | Notes |
|---------|-------|
| Parent upgrade explorer | Recursive parent-chain exploration with 9 guardrails (depth, cycles, candidate limit, simulation limit) |
| Manifest inspection per candidate | `getManifest(name, version)` with per-run cache in registry.js |
| npm install simulation | `simulator.js` — temp-dir `npm install --package-lock-only`; `simulationVerified: true` on confirmed paths |
| Override-set minimization | `override-minimizer.js` — iteratively simulates removal; `mendfix cleanup --simulate` |
| Multi-path comparison | `remediation-paths.js` — buildPaths, rankPaths, comparePaths; Change Budget ranking |
| Decision label taxonomy | SAFE_ALIGNED / SAFE_PARENT_UPGRADE / CONTROLLED_OVERRIDE / NOT_FIXABLE / NON_RUNTIME_EXPOSURE / MANUAL_SECURITY_REVIEW |
| Security delta | `security-delta.js` — detects regressions introduced by a candidate version |
| Blast radius | `buildBlastRadius` in lock-parser.js — BFS reverse-dep graph |
| Safety Gate | Pre-apply checklist; `--force` bypass; halts on regressions or MANUAL confidence |
| Whole-graph before/after diff | `graph-diff.js` — `graph-diff.md` written after every successful npm install |
| Mixed dev/runtime chain | `applyPhases` accepts `rootDeps` param; full Scenario 8 classification |
| Renovate PR relationship analysis | `analyzePRRelationships` — redundancy detection, merge order |

---

## Phase 2 — Universal Finding Engine ✅ Complete

| Provider | Notes |
|----------|-------|
| Snyk | `snyk test --json` standard + `--all-projects` + flat array shapes |
| npm audit | v1 (npm 6 advisories) + v2 (npm 7+ vulnerabilities); cross-refs lock file for installed versions |
| Dependabot | GitHub Security API alerts JSON; skips dismissed; cross-refs lock file |
| OWASP Dependency-Check | JSON schema 1.1; purl extraction for npm + Maven |
| OSV | osv-scanner JSON + OSV API bulk shapes; SEMVER/ECOSYSTEM range events |
| Trivy | JSON SchemaVersion 2; multi-ecosystem: npm, Maven, Go, Python; comma-separated fix versions |
| GitLab Dependency Scanning | v15+ JSON; fix version from remediations map → solution text → identifiers |
| JFrog Xray | purl parsing: npm/gav/pypi/go/nuget/cargo schemes; installed version embedded |

---

## Phase 3 — Universal Dependency Engine ✅ Complete

| Ecosystem | Components |
|-----------|-----------|
| Python | lock-parser (poetry.lock/Pipfile.lock/requirements.txt), writer, PyPI registry, pip installer, venv simulator |
| Go | lock-parser (go.mod), writer (replace directives), proxy.golang.org registry, go mod installer, simulator |
| .NET / NuGet | lock-parser (packages.lock.json + .csproj), writer (Directory.Packages.props), NuGet registry, dotnet restore installer, simulator |
| Rust / Cargo | lock-parser (Cargo.lock TOML), writer (Cargo.toml + [patch.crates-io]), crates.io registry, cargo update installer, simulator |

---

## Phase 4 — CI/CD Platform Write-back ✅ Complete

| Feature | Notes |
|---------|-------|
| GitHub PR creation | `createPR` in providers/github.js |
| GitLab MR creation | `createMR` + `addMRComment` in providers/gitlab.js; self-hosted via `--gitlab-url` |
| Azure DevOps PR creation | `createPR` + `addComment` in providers/azuredevops.js; PAT auth |
| Bitbucket PR creation | `createPR` + `addComment` in providers/bitbucket.js; Basic or Bearer auth |
| pr-poster dispatcher | `src/core/pr-poster.js` — platform-agnostic validation + dispatch |
| CLI wiring | `mendfix apply --open-pr --platform <name>` + per-platform credential flags |

---

## Phase 5 — Multi-repo Portfolio Mode ✅ Complete

| Feature | Notes |
|---------|-------|
| Portfolio orchestrator | `portfolio-runner.js` — `loadConfig`, `analyzeRepo`, `runPortfolio` |
| Portfolio report | `src/core/portfolio-report.js` — severity summary, phase distribution, action priority sort |
| CLI subcommand | `mendfix portfolio --config portfolio.json` |

---

## Phase 5.5 — Enterprise Trust and Pilot Release (current)

| Mission | Feature | Status |
|---------|---------|--------|
| M1 | Secure process execution — centralized safe executor, no shell-string interpolation | Planned |
| M1 | Credential handling — env/SecretStorage preferred; no tokens in reports/logs | Planned |
| M1 | Canonical orchestration API — one pipeline for CLI, UI, portfolio, CI | Planned |
| M1 | Confirmed gap: VS Code extension bypasses enrichWithConfidence + enrichWithPaths | Confirmed |
| M1 | Product threat model (THREAT_MODEL.md, SECURITY_ARCHITECTURE.md) | Planned |
| M1 | Reproducible clean CI | Planned |
| M1 | Documentation reconciliation across all status files | Planned |
| M2 | Configurable build/test verification commands | Planned |
| M2 | Post-remediation rescan adapter (4 outcome states) | Planned |
| M2 | Fail-closed safety gate for Phase A application | Planned |
| M2 | Canonical versioned evidence model (JSON + SARIF + CycloneDX/VEX) | Planned |
| M2 | Outcome taxonomy (FIXED / NOT_AFFECTED / MITIGATED / PATCHED / FORKED / ...) | Planned |
| M2 | Benchmark corpus + measured metrics | Planned |
| M3 | GitHub Actions CI integration | Planned |
| M3 | Repository policy file (.dependency-intelligence.yml) | Planned |
| M3 | Append-only structured audit trail | Planned |
| M3 | Pilot KPI report with exposure-aware metrics | Planned |
| M3 | Pilot runbook | Planned |

---

## Phase 5.6 — Deep Remediation Intelligence

| Sub-phase | Feature | Status |
|-----------|---------|--------|
| D1A | Exposure classification (RUNTIME_REACHABLE / TEST_ONLY / CI_EXECUTED / ...) | Planned (before M3) |
| D1B | Unused dep detection + retirement signals + preventive hygiene | Planned (after M3) |
| D2.1 | API usage fingerprint | Planned |
| D2.2 | Alternative-package intelligence and scoring | Planned |
| D2.3 | Migration strategy comparison | Planned |
| D2.4 | Prototype branches + behavioral comparison | Stretch goal |
| D3.1 | Native npm patch support | Planned |
| D3.2 | Fix Transplant Engine | Planned |
| D3.3 | Internal fork workflow with fork-debt ledger | Planned |
| D3.4 | LLM-assisted candidate patches (feature-flag gated, human-approval required) | Planned |
| D3.5 | Licensing gate | Planned |
| D3.6 | Upstream disclosure preparation | Planned |

---

## Phase 6 — Focused UI Layer

| Step | Feature | Priority | Notes |
|------|---------|----------|-------|
| 1 | VS Code extension rebuilt on canonical API (M1.3) | P1 | Fixes gap: panel.js currently bypasses confidence + path enrichment |
| 2 | Read-only evidence and analysis view | P1 | Visualizes canonical evidence; no separate decision logic in UI |
| 3 | Governed apply/approval workflow | P1 | Phase C read-only; Phase B approval-gated |
| 4 | Portfolio/pilot KPI view with exposure breakdown | P2 | Uses exposure data from D1A |
| 5 | Tauri standalone app | P3 | Deferred until pilot evidence shows demand |
| 6 | Chrome Extension PR overlay | P3 | Deferred until pilot evidence shows demand |

---

## Phase 7 — Dependency Outcome Knowledge Graph

Collect event schema now; build intelligence only after real outcomes exist.

| Feature | Status |
|---------|--------|
| Event schema design | Planned |
| Remediation outcome storage | Planned |
| Successful migration recipe store | Planned |
| PR outcome + rollback tracking | Planned |

---

## Phase 8 — Organization-Specific Dependency Intelligence

| Feature | Status |
|---------|--------|
| Repository-specific compatibility history | Planned |
| Reusable remediation recipes | Planned |
| Regression-aware recommendations | Planned |
| Predictive change risk | Planned |

---

## Phase 9 — LLM Intelligence

| Feature | Status |
|---------|--------|
| Changelog + migration-guide analysis | Planned |
| Root-cause explanation | Planned |
| Candidate codemods | Planned |
| Backport assistance | Planned |
| Natural-language evidence queries | Planned |

LLM suggestions remain subordinate to deterministic evidence, policy and verification.

---

## Deferred / Won't do

| Item | Reason |
|------|--------|
| AI-based SemVer resolution | Non-deterministic. `semver` package is the source of truth. |
| `@^major` scoped override selectors | Unreliable across npm versions. Multi-major → Phase C. |
| TypeScript rewrite | CLAUDE.md explicitly prohibits. Plain CommonJS only. |
| Electron app | Same capability as Tauri at 15× larger install size. |
| Phase C auto-apply via LLM | Phase C must always require human approval. |
