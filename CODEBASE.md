# Codebase Reference

Quick-load document for any new session. Read this before touching any file.
**Rule: update this file after every session that adds, removes, or renames a file or function.**

Last updated: 2026-08-12

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
| `index.js` | `detectProvider(filePath)`, `getParser(provider)` | Auto-detect report format; return parser module |
| `mend.js` | `parseReport(filePath)` → `LibraryEntry[]` | Parse Mend JSON + Excel reports |
| `github.js` | `fetchRenovatePRs(org,repo,token)`, `postComment(...)`, `closePR(...)` | GitHub API for Renovate PR workflow |

### src/core/

| File | Exports | Purpose |
|------|---------|---------|
| `semver-engine.js` | `resolveFixVersion(entry)`, `buildResolutionPlan(entries)` → `ResolutionItem[]` | Deterministic SemVer resolution. NEVER use AI here. |
| `phases.js` | `PHASE_META`, `classifyPhase(item, allItems)`, `applyPhases(plan, depTree?)` → `PhasedItem[]` | Phase A/B/C classification |
| `confidence.js` | `enrichWithConfidence(phasedPlan, depTree)` → `PhasedItem[]` + `evidence`+`alternative` fields | Adds evidence text per item. **NOT yet called from mendfix.js main path.** |
| `report.js` | `generateReport(phasedPlan, opts)` → `string` | Full markdown remediation report |
| `pr-description.js` | `generatePRDescription(phasedPlan, reportMeta)` → `string` | PR description markdown |
| `git-commits.js` | `commitPhaseA(projectDir, items, ecosystem)`, `commitPhaseBC(projectDir, bItems, cItems)`, `commitFalsePositives(projectDir, items)` | Git auto-commit by confidence tier. All synchronous. commitPhaseBC/commitFalsePositives = opt-in after human review. |
| `renovate-builder.js` | `buildResolutionItems(prUpgrades, pkg, lockEntries?)`, `getCurrentVersion(name, pkg, lockEntries?)` | Convert Renovate PR upgrades → `ResolutionItem[]` |
| `renovate-classifier.js` | `classifyPRs(renovatePRs, phasedItems)`, `parsePRTitleNew(title)`, `summarize(classifiedPRs)`, `buildCloseComment(classified)`, `CATEGORIES` | Classify Renovate PRs against Mend findings |
| `renovate-report.js` | `generateMarkdown(repoResults, runDate)`, `writeReport(repoResults, outDir, runDate)` | Multi-repo Renovate workflow report |
| `renovate-apply-report.js` | `generateApplyReport(params)`, `writeApplyReport(params, outDir)` | Per-repo Renovate apply report |

### src/ecosystems/

| File | Exports | Purpose |
|------|---------|---------|
| `index.js` | `detectEcosystem(entries, override?)` → `'npm'\|'maven'` | Auto-detect ecosystem from LibraryEntry types |

### src/ecosystems/npm/

| File | Exports | Purpose |
|------|---------|---------|
| `lock-parser.js` | `parseLockFile(path)` → `DepTree`, `getRootDeps(path)`, `findDepChain(name, tree, rootDeps)` → `string[]` | Parse package-lock.json v2/v3 flat map → DepTree |
| `overrides.js` | `buildPhaseAOverrides`, `buildPhaseBOverrides`, `buildParentUpgradeMap`, `applyOverridesToPackageJson`, `writeOverridesPatch`, `detectDirectDeps`, `applyDirectUpgrades` | Build + apply npm overrides/direct dep bumps |
| `installer.js` | `snapshotFiles`, `restoreFiles`, `runPackageLockUpdate`, `runMavenResolve`, `verifyFixVersions`, `saveManifest`, `detectManualChanges` | npm/mvn install, rollback, verify, manifest |
| `registry.js` | `getPublishedVersions(name)`, `resolveToAvailableVersion(name, ver)`, `verifyPlanVersions(plan)` | npm registry version checks (Node 18+ fetch) |
| `parent-upgrade-explorer.js` | `findParentUpgradePaths(item)` → `ParentUpgradePath[]`, `exploreParentUpgrades(phasedPlan, ecosystem)` | 2-level parent upgrade exploration. Static SemVer only — no simulation yet. |

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
  evidence?: string,      // set by confidence.js — NOT in mendfix.js path yet
  alternative?: string    // set by confidence.js — NOT in mendfix.js path yet
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

Run all: `npx jest --no-coverage`  
Baseline: **32/32 pass**

---

## Current V1 Status

| Gap | Status |
|-----|--------|
| Scenarios 15/16: git-commits.js wiring (`--commit` flag) | ✅ DONE 2026-08-12 |
| Scenario 18: pr-description.js | ✅ DONE 2026-08-12 |
| Maven dep-tree.js | ✅ DONE 2026-08-12 |
| Scenario 14: `enrichWithConfidence` into mendfix CLI path | ⏳ PENDING (only in renovate-apply.js) |

**Next:** Wire `enrichWithConfidence` from `src/core/confidence.js` into `mendfix.js` — call after `applyPhases`, pass `phasedPlan` + `depTree`.

---

## Output Files (written to `--out-dir`, default: `<report-dir>/mend-output/`)

| File | Phase | Ecosystem |
|------|-------|-----------|
| `phase-a-overrides.json` | A | npm |
| `phase-b-overrides.json` | B | npm |
| `phase-b-parent-upgrades.json` | B (parent paths) | npm |
| `phase-a-pom-patch.xml` | A | maven |
| `phase-b-pom-patch.xml` | B | maven |
| `manual-review.md` | C | both |
| `remediation-report.md` | all | both |
| `pr-description.md` | all | both |
| `.mend-manifest.json` | — | both (idempotency) |
