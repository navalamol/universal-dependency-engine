# Codebase Reference

Quick-load document for any new session. Read this before touching any file.
**Rule: update this file after every session that adds, removes, or renames a file or function.**

Last updated: 2026-08-12 (Python + Go ecosystems)

---

## Entry Points

| Command | File | Function/Route |
|---------|------|---------------|
| `mendfix analyze` | `mendfix.js` | Sets `--dry-run=true`, runs `main()` |
| `mendfix apply` | `mendfix.js` | Runs `main()` — writes files + installs |
| `mendfix apply --commit` | `mendfix.js` | Same + calls `commitPhaseA` after install |
| `mendfix cleanup` | `mendfix.js` | Calls `runCleanup(lockFilePath, pkgJsonPath)` |
| `mendfix renovate` | `mendfix.js` → `renovate-apply.js` | `renovateMain(rawArgs)` |
| `node renovate-apply.js` | `renovate-apply.js` | Standalone Renovate workflow CLI |
| `node mend-fix.js` | `mend-fix.js` | Shim → `require('./mendfix')` (backward compat) |

---

## Architecture

```
Provider → Core (SemVer + Phase Classifier) → Ecosystem Writer + Report
```

**Core isolation rule:** `src/core/` has zero imports from `src/providers/` or `src/ecosystems/`.

**Data pipeline:**

```
parseReport(file) → LibraryEntry[]
  ↓ buildResolutionPlan()
ResolutionItem[]
  ↓ applyPhases(plan, depTree?)
PhasedItem[]
  ↓ enrichWithConfidence(plan, depTree?)       ← ONLY wired in renovate-apply.js, NOT in mendfix.js
PhasedItem[] + evidence/alternative fields
  ↓ ecosystem writers (overrides.js / pom-writer.js)
package.json / pom.xml mutations
  ↓ installer (runPackageLockUpdate / runMavenResolve)
lockfile update + verification
```

---

## File Map

### Root

| File | Purpose |
|------|---------|
| `mendfix.js` | Main CLI. `parseArgs()` at line 42. `main()` at line 251. Apply block at line ~462. Commit block at ~503. |
| `renovate-apply.js` | Renovate-focused apply workflow. `main(argv)` exported. Also runs standalone. |
| `mend-fix.js` | Backward-compat shim. Do not modify. |

### src/providers/

| File | Exports | Purpose |
|------|---------|---------|
| `index.js` | `detectProvider(filePath)`, `getParser(provider)`, `PROVIDER_NAMES` | Auto-detect report format; return parser module. 9 providers: mend, snyk, npm-audit, dependabot, owasp, osv, trivy, gitlab, xray |
| `mend.js` | `parseReport(filePath)` → `LibraryEntry[]` | Parse Mend JSON + Excel reports |
| `snyk.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isSnykFormat(data)` → `bool` | Parse Snyk JSON reports (standard + all-projects shapes) |
| `npm-audit.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isNpmAuditFormat(data)` → `bool` | Parse `npm audit --json` output (v1 npm 6 advisories shape + v2 npm 7+ vulnerabilities shape). Cross-references package-lock.json for installed versions in v2. |
| `dependabot.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isDependabotFormat(data)` → `bool` | Parse GitHub Dependabot alerts JSON (from GitHub Security API / `gh api …/dependabot/alerts`). Skips dismissed alerts; cross-references package-lock.json for installed versions. |
| `owasp.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isOwaspFormat(data)` → `bool` | Parse OWASP Dependency-Check JSON report (schema 1.1). Extracts name+version from purl `pkg:npm/…@version`; fix versions from `versionEndExcluding`; supports both npm and Maven artifacts. |
| `osv.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isOsvFormat(data)` → `bool` | Parse OSV-format reports: osv-scanner JSON (`results[].packages`) and OSV API bulk (`vulns[]`). osv-scanner shape embeds installed version; bulk shape cross-references lock file. Fix versions from SEMVER/ECOSYSTEM range events. CVE ID preferred over GHSA over raw OSV id. |
| `trivy.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isTrivyFormat(data)` → `bool` | Parse Trivy JSON (SchemaVersion 2). Embeds both InstalledVersion and FixedVersion — no lock file needed. Multi-ecosystem: npm, Maven, Go (GO_MODULE), Python (PYTHON_PACKAGE) all parsed; unknown ecosystem types pass through with NODE_PACKAGED_MODULE fallback. FixedVersion can be comma-separated multi-version string. |
| `gitlab.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isGitlabFormat(data)` → `bool` | Parse GitLab Dependency Scanning JSON (gl-dependency-scanning-report.json, v15+). Ecosystem inferred from location.file (pom.xml → maven, else npm). Fix version from: top-level remediations map → solution field → identifiers type=remediation. CVE from identifiers type=cve. |
| `xray.js` | `parseReport(filePath)` → `LibraryEntry[]`, `isXrayFormat(data)` → `bool` | Parse JFrog Xray JSON. Installed version embedded in component_id purl: npm://name:ver, gav://group:artifact:ver, pypi://name:ver, go://module@ver. Fix versions from components[].fixed_versions[]. No lock file needed. |
| `github.js` | `fetchRenovatePRs(org,repo,token)`, `postComment(...)`, `closePR(...)` | GitHub API for Renovate PR workflow |

### src/core/

| File | Exports | Purpose |
|------|---------|---------|
| `semver-engine.js` | `resolveFixVersion(entry)`, `buildResolutionPlan(entries)` → `ResolutionItem[]` | Deterministic SemVer resolution. NEVER use AI here. |
| `phases.js` | `PHASE_META`, `classifyPhase(item, allItems)`, `applyPhases(plan, depTree?, rootDeps?)` → `PhasedItem[]` | Phase A/B/C classification; mixed dev/runtime chain detection when rootDeps provided |
| `confidence.js` | `enrichWithConfidence(phasedPlan, depTree)` → `PhasedItem[]` + `evidence`+`alternative` fields | Adds evidence text per item |
| `remediation-paths.js` | `buildPaths(item, allFindings?)`, `rankPaths(paths)`, `comparePaths(item, allFindings?)`, `enrichWithPaths(phasedPlan, allFindings?)`, `LABELS`, `BUDGET_TIERS` | Multi-path comparison + Change Budget ranking; adds `recommendedPath`, `alternativePaths[]`, `decisionLabel` to every PhasedItem; `securityDelta` computed per PARENT_UPGRADE path when allFindings provided |
| `security-delta.js` | `computeSecurityDelta(resolvedVersions, findings)` → `{introduced[], fixed[]}` | Cross-reference simulation resolvedVersions against LibraryEntry[] findings; detects regressions introduced by a candidate |
| `graph-diff.js` | `captureGraph(lockFilePath)` → `Map<name, string[]>\|null`, `diffGraphs(before, after)` → `{added, removed, changed, unchangedCount}`, `formatDiff(diff, meta?)` → `string` | Whole-graph before/after diff (Item 14). captureGraph snapshots all resolved versions from a lockfile; diffGraphs diffs two snapshots; formatDiff produces markdown. Wired into writeOutputNpm: graph-diff.md written after every successful install. |
| `report.js` | `generateReport(phasedPlan, opts)` → `string` | Full markdown remediation report |
| `pr-description.js` | `generatePRDescription(phasedPlan, reportMeta)` → `string` | PR description markdown |
| `git-commits.js` | `commitPhaseA(projectDir, items, ecosystem)`, `commitPhaseBC(projectDir, bItems, cItems)`, `commitFalsePositives(projectDir, items)` | Git auto-commit by confidence tier. All synchronous. commitPhaseBC/commitFalsePositives = opt-in after human review. |
| `renovate-builder.js` | `buildResolutionItems(prUpgrades, pkg, lockEntries?)`, `getCurrentVersion(name, pkg, lockEntries?)` | Convert Renovate PR upgrades → `ResolutionItem[]` |
| `renovate-classifier.js` | `classifyPRs(renovatePRs, phasedItems)`, `parsePRTitleNew(title)`, `summarize(classifiedPRs)`, `buildCloseComment(classified)`, `analyzePRRelationships(classifiedPRs, phasedItems)`, `CATEGORIES` | Classify Renovate PRs against Mend findings; PR redundancy/chain/order analysis |
| `renovate-report.js` | `generateMarkdown(repoResults, runDate)`, `writeReport(repoResults, outDir, runDate)` | Multi-repo Renovate workflow report |
| `renovate-apply-report.js` | `generateApplyReport(params)`, `writeApplyReport(params, outDir)` | Per-repo Renovate apply report |

### src/ecosystems/

| File | Exports | Purpose |
|------|---------|---------|
| `index.js` | `detectEcosystem(entries, override?)` → `'npm'\|'maven'\|'python'\|'go'` | Auto-detect ecosystem from LibraryEntry types (PYTHON_PACKAGE → python, GO_MODULE → go) |

### src/ecosystems/npm/

| File | Exports | Purpose |
|------|---------|---------|
| `lock-parser.js` | `parseLockFile(path)` → `DepTree`, `getRootDeps(path)`, `findDepChain(name, tree, rootDeps)` → `string[]`, `buildBlastRadius(name, tree)` → `BlastRadius` | Parse package-lock.json v2/v3 flat map → DepTree; reverse-dep index for blast radius |
| `overrides.js` | `buildPhaseAOverrides`, `buildPhaseBOverrides`, `buildParentUpgradeMap`, `applyOverridesToPackageJson`, `writeOverridesPatch`, `detectDirectDeps`, `applyDirectUpgrades` | Build + apply npm overrides/direct dep bumps |
| `installer.js` | `snapshotFiles`, `restoreFiles`, `runPackageLockUpdate`, `runMavenResolve`, `verifyFixVersions`, `saveManifest`, `detectManualChanges` | npm/mvn install, rollback, verify, manifest |
| `registry.js` | `getPublishedVersions(name)`, `getManifest(name, ver)`, `resolveToAvailableVersion(name, ver)`, `verifyPlanVersions(plan)` | npm registry version checks + manifest fetch with per-run cache (Node 18+ fetch) |
| `parent-upgrade-explorer.js` | `findParentUpgradePaths(item, opts?)` → `ParentUpgradePath[]`, `exploreParentUpgrades(phasedPlan, ecosystem, pkgJsonPath, lockPath, opts?)`, `recursiveResolveChainChildRange(name, ver, chain, childName, fixVersion, ctx)` | Recursive parent-chain exploration (Step G). Explores multiple candidate versions at each intermediate hop. All 9 guardrails: cycle detection, depth limit (5), candidate limit (10), simulation limit (20, shared). |
| `override-minimizer.js` | `minimizeOverrides(packageJsonPath, lockFilePath, opts?)` → `{removed, kept, skipped, limitHit}` | Override-set minimization (Item 13). Iteratively simulates removal of each flat-string override; marks it removable only when npm still resolves the fix version without it. Iterates in rounds until stable. Wired into mendfix cleanup --simulate. |
| `simulator.js` | `simulate(...)`, `simulatePackage(pkgObject, lockPath, opts?)` → SimulationResult | simulatePackage added: takes a ready-made pkg object (not base+candidates), used by override-minimizer to test post-removal state. |
| `simulator.js` | `simulate(basePackageJsonPath, baseLockPath, candidates, options?)` → `SimulationResult[]` | Isolated `npm install --package-lock-only` in temp dir. Per-run cache + 20-sim limit + 30s timeout guardrails. |

### src/ecosystems/python/

| File | Exports | Purpose |
|------|---------|---------|
| `lock-parser.js` | `parseLockFile(path)` → `DepTree`, `detectLockFile(dir)` → `string\|null` | Parse poetry.lock, Pipfile.lock, requirements.txt (pinned lines only) → DepTree. poetry.lock builds parents/requires graph; others are flat. |
| `writer.js` | `writeRequirementsPatch`, `applyPinsToRequirements`, `applyPinsToPyprojectToml`, `buildManualReview`, `saveManifest`, `detectManualChanges` | Write phase-specific requirements.txt patches; apply pins in-place to requirements.txt or pyproject.toml |
| `registry.js` | `getPublishedVersions(name)`, `resolveToAvailableVersion(name, ver)`, `verifyPlanVersions(plan)` | PyPI version check (pypi.org/pypi/{name}/json) |
| `installer.js` | `snapshotFiles`, `restoreFiles`, `runPipInstall(projectDir, reqPath)`, `verifyFixVersions(items, projectDir)` | pip install + verify installed versions via `pip show` |
| `simulator.js` | `simulate(baseReqPath, candidates, opts?)` → `SimulationResult` | Isolated pip install in temp venv; returns resolvedVersions Map |

### src/ecosystems/go/

| File | Exports | Purpose |
|------|---------|---------|
| `lock-parser.js` | `parseLockFile(path)` → `DepTree`, `parseReplaceDirectives(goModPath)` → `Map` | Parse go.mod require block → DepTree; go.sum defers to adjacent go.mod. Replace directives applied to resolvedVersion. |
| `writer.js` | `writeGoModPatch`, `applyReplaceDirectives`, `buildManualReview`, `saveManifest`, `detectManualChanges` | Write phase-specific go.mod replace-directive snippets; apply replace directives in-place |
| `registry.js` | `getPublishedVersions(modulePath)`, `resolveToAvailableVersion(modulePath, ver)`, `verifyPlanVersions(plan)` | Go module proxy version check (proxy.golang.org/{module}/@v/list). Respects GOPROXY env var. |
| `installer.js` | `snapshotFiles`, `restoreFiles`, `runGoModTidy(projectDir)`, `runGoModVerify(projectDir)`, `verifyFixVersions(items, projectDir)` | `go mod tidy` + `go mod verify` + version check via `go list -m all` |
| `simulator.js` | `simulate(goModPath, candidates, opts?)` → `SimulationResult` | Apply replace directives in temp dir + `go mod download`; returns resolvedVersions Map |

### src/ecosystems/maven/

| File | Exports | Purpose |
|------|---------|---------|
| `pom-writer.js` | `buildPomPatch`, `writePomPatch`, `applyPomPatch`, `detectManualChanges` | Write + apply pom.xml dependencyManagement patches |
| `registry.js` | `getPublishedVersions(groupId, artifactId)`, `resolveToAvailableVersion(gId, aId, ver)`, `verifyPlanVersions(plan)` | Maven Central version checks (300ms delay for rate limits) |
| `dep-tree.js` | `buildMavenDepTree(projectDir)` → `DepTree\|null`, `parseMavenDepTreeText(text)` → `DepTree` | Run + parse `mvn dependency:tree` output into DepTree |

---

## Data Shapes (canonical interfaces — never change)

```js
// LibraryEntry — output of any provider parser
{
  libraryKey: string,
  libraryName: string,
  groupId: string | null,          // Maven only
  libraryType: string,             // 'MAVEN_ARTIFACT' | npm package type
  currentVersion: string,
  filename: string,
  dependencyFile: string,
  cves: [{ id, severity, score, fixVersions: string[] }]
}

// ResolutionItem — output of semver-engine.js
LibraryEntry + {
  cveCount: number,
  highestSeverity: string,
  highestCvssScore: number,
  recommendedVersion: string | null,
  upgradeType: 'SAFE' | 'MAJOR_BUMP' | 'NO_FIX'
}

// PhasedItem — output of phases.js
ResolutionItem + {
  phase: 'A' | 'B' | 'C',
  justification: string,
  rangeViolation?: { consumer: string, range: string },
  probableFalsePositive?: boolean,
  nestedOverrides?: { [parentPkg]: { [childPkg]: version } },
  parentUpgradePaths?: ParentUpgradePath[],   // set by parent-upgrade-explorer
  _parentExplorationRan?: boolean,
  rootParents?: [{ name, range, isDev, chainVia? }],
  depChain?: string[],
  evidence?: string,           // set by confidence.js
  alternative?: string,        // set by confidence.js
  recommendedPath?: Path,      // set by remediation-paths.js
  alternativePaths?: Path[],   // set by remediation-paths.js
  decisionLabel?: string,      // set by remediation-paths.js (LABELS value)
}

// DepTree — output of lock-parser.js / dep-tree.js
Map<packageName, Entry[]>

// Entry (npm lock-parser)
{
  resolvedVersion: string,
  dev: boolean,
  requires: { [pkgName]: rangeString },
  parents: [{ name: string, range: string }]
}

// Entry (Maven dep-tree) — note: range is always '*'
{
  resolvedVersion: string,
  dev: boolean,           // true if scope=test
  parents: [{ name: string, range: '*' }],
  groupId: string
}

// ParentUpgradePath — output of parent-upgrade-explorer.js
{
  parent: string,
  parentAllowedRange: string,
  parentUpgradeVersion: string,
  childDeclaredRange: string,
  childFixVersion: string,
  chainVia: string[],
  isDev: boolean
}
```

---

## Key Constants

```js
// PHASE_META (phases.js)
{
  A: { label: 'Auto-apply', confidence: '95-100%', description: '...' },
  B: { label: 'Review first', confidence: '60-95%', description: '...' },
  C: { label: 'Manual review', confidence: '<60%', description: '...' }
}

// CATEGORIES (renovate-classifier.js)
COVERED_PHASE_A | COVERED_PHASE_B | DISCARDED_MAJOR_BUMP | DISCARDED_MULTI_MAJOR |
DISCARDED_NO_FIX | RENOVATE_INSUFFICIENT | NOT_IN_MEND_REPORT | MONOREPO_GROUP_UPDATE
```

---

## Hard Rules (violations break things)

- `src/core/` — zero imports from `src/providers/` or `src/ecosystems/`
- MAJOR_BUMP → Phase C always. Never auto-apply.
- No `@^major` selectors in any overrides output
- `--package-json <path>` applies Phase A only
- Phase B/C commits: opt-in after human review. Never auto-trigger.
- No AI in SemVer resolution — `semver` package only
- `mend-fix.js` shim must stay (backward compat)

---

## Tests

| Test file | Covers |
|-----------|--------|
| `tests/core/semver-engine.test.js` | `resolveFixVersion`, `buildResolutionPlan` |
| `tests/core/phases.test.js` | `applyPhases`, Phase A/B/C classification, consumer range validation |
| `tests/core/confidence.test.js` | `enrichWithConfidence` evidence/alternative fields |
| `tests/ecosystems/npm/lock-parser.test.js` | `parseLockFile`, `getRootDeps`, `findDepChain` |
| `tests/ecosystems/npm/installer.test.js` | `snapshotFiles`, `restoreFiles`, `saveManifest`, `detectManualChanges` |
| `tests/integration/regression-mend-report.test.js` | End-to-end: parse → resolve → phase → report. Baseline: A:5 B:0 C:3 |
| `tests/providers/providers-new.test.js` | npm-audit (v1+v2), dependabot, owasp parsers + format detection + detectProvider routing |
| `tests/providers/providers-osv-trivy.test.js` | osv (scanner + bulk shapes), trivy (npm/maven/go/python results) + detectProvider routing |
| `tests/providers/providers-gitlab-xray.test.js` | gitlab (npm+maven, solution/remediations fix parsing), xray (npm+maven+component_id edge cases) |

Run all: `npx jest --no-coverage`  
Baseline: **238/238 pass**

---

## Current V1 Status

| Gap | Status |
|-----|--------|
| Scenarios 15/16: git-commits.js wiring (`--commit` flag) | ✅ DONE 2026-08-12 |
| Scenario 18: pr-description.js | ✅ DONE 2026-08-12 |
| Maven dep-tree.js | ✅ DONE 2026-08-12 |
| Scenario 14: `enrichWithConfidence` into mendfix CLI path | ✅ DONE 2026-08-12 |
| Python ecosystem (lock-parser, writer, registry, installer, simulator) | ✅ DONE 2026-08-12 |
| Go ecosystem (lock-parser, writer, registry, installer, simulator) | ✅ DONE 2026-08-12 |

**Next:** Python and Go ecosystems shipped. All 4 ecosystems now at parity. Next work is simulator wiring into cleanup + override-minimizer equivalents for Python/Go, or intelligence layer (Phase 2).

---

## Output Files (written to `--out-dir`, default: `<report-dir>/mend-output/`)

| File | Phase | Ecosystem |
|------|-------|-----------|
| `phase-a-overrides.json` | A | npm |
| `phase-b-overrides.json` | B | npm |
| `phase-b-parent-upgrades.json` | B (parent paths) | npm |
| `phase-a-pom-patch.xml` | A | maven |
| `phase-b-pom-patch.xml` | B | maven |
| `phase-a-requirements.txt` | A | python |
| `phase-b-requirements.txt` | B | python |
| `phase-a-go-mod.txt` | A | go |
| `phase-b-go-mod.txt` | B | go |
| `manual-review.md` | C | all |
| `remediation-report.md` | all | all |
| `pr-description.md` | all | all |
| `.mend-manifest.json` | — | all (idempotency) |
