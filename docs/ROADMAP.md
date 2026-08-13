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

## Phase 6 — UI Layer (next)

| Step | Feature | Priority | Notes |
|------|---------|----------|-------|
| 1 | VS Code Extension scaffold | P1 | `packages/vscode-extension/` — extension host + Webview panel + vsce manifest |
| 2 | Report upload & analysis panel | P1 | File picker, provider auto-detect, phase A/B/C cards, CVE table, confidence display |
| 3 | Apply / Commit / PR controls | P1 | One-click apply, SecretStorage tokens, progress stream, rollback UI, Phase C read-only |
| 4 | Settings form & portfolio builder | P2 | Visual config for all CLI flags; portfolio.json builder; vsce publish to marketplace |
| 5 | Tauri standalone app | P3 | Sidecar wraps same engine; shares 100% of Webview frontend; ~10 MB install |
| 6 | Chrome Extension PR overlay | P3 | MV3; GitHub/GitLab PR badge overlay; read-only; bridges to local VS Code/Tauri server |

Delivery rationale: VS Code Extension primary — developers already there; full Node.js API access; marketplace distribution. Tauri secondary — IDE-independent, tiny install. Chrome Extension companion only — cannot run shell commands or access filesystem.

---

## Deferred / Won't do

| Item | Reason |
|------|--------|
| AI-based SemVer resolution | Non-deterministic. `semver` package is the source of truth. |
| `@^major` scoped override selectors | Unreliable across npm versions. Multi-major → Phase C. |
| TypeScript rewrite | CLAUDE.md explicitly prohibits. Plain CommonJS only. |
| Backwards-compat shims for old output | No consumers of old format. |
| Deep mixed dev/runtime chain classification (Scenario 8 full) | All-dev check covers real cases; mixed-chain BFS deferred to Phase 6+ |
