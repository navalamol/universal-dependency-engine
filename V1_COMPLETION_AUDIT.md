# V1 Completion Audit — universal-dependency-engine

**Date:** 2026-08-12
**Auditor:** Claude (skeptical reviewer pass)
**Scope:** Full source audit against `Plans_Prompst/MendAutoFixer_V1_Audit_Gap.md` requirements

---

## A. Executive Summary

The core npm/Mend remediation pipeline — `semver-engine → phases → overrides → install → report`
— is approximately **90% complete** and functionally sound on the happy path. The engine
correctly handles same-major safe upgrades, consumer range validation, multi-major conflict
detection, nested override generation, dev-only false-positive flagging, and rollback on install
failure.

**The single largest structural gap is zero automated tests.** No test framework, no test files,
no fixtures, and no CI gate exist anywhere in the project. The `"test"` script in `package.json`
is a manual smoke-check against a hardcoded path that does not exist inside the repository.

**Five correctness defects** can produce wrong or misleading recommendations in production today:

1. `confidence.js` field name bug — evidence strings for range-violation items always display
   `undefined` as the consumer name
2. Post-install verification failure is warning-only — a CVE that survives remediation is not
   rolled back; the tool reports success while the lock file still carries the vulnerable version
3. Manual override removal is not detected — silently re-applies the deleted override on the
   next run
4. `renovate-workflow.js` calls `applyPhases` without a dep-tree, producing Phase A items
   that would be classified Phase B or C by the standard Mend path for the same packages
5. `providers/index.js` is never called — `mendfix.js` hard-imports `src/providers/mend.js`
   directly, leaving the provider abstraction entirely unused

**Three security issues:**

1. GitHub token embedded in the git clone URL (`https://x-access-token:TOKEN@github.com/...`)
   — token appears in process args and potentially in `.git/config`
2. `fetch` is used but is only stable on Node ≥18; `package.json` allows `>=16`, causing
   `ReferenceError: fetch is not defined` on Node 16
3. Maven pom values inserted into XML without escaping — potential XML injection for
   non-standard Maven coordinates

**Current maturity by area:**

| Area | Status |
|---|---|
| npm/Mend core path | ~90% — 5 correctness defects |
| Maven path | Structural only — dep-tree layer missing; all enrichments disabled |
| Renovate apply workflow | Partially functional — npm only, diverges from Mend path |
| Renovate classify/close workflow | Partially functional — phase accuracy reduced |
| Test coverage | Zero |
| Security | 3 issues (1 high, 2 medium) |

---

## B. Implemented Capabilities

Only capabilities confirmed by reading the source code are listed.

| Capability | Implementation |
|---|---|
| Mend JSON report parsing → `LibraryEntry[]` | `src/providers/mend.js:parseJson` |
| Mend Excel report parsing → `LibraryEntry[]` | `src/providers/mend.js:parseExcel` |
| SemVer fix resolution: same-major minimum, cross-major fallback, no-fix | `src/core/semver-engine.js:resolveFixVersion` |
| Multi-CVE coverage: single version covering all CVEs for a package | `src/core/semver-engine.js:resolveFixVersion` (Path A) |
| Phase A/B/C classification with justifications | `src/core/phases.js:classifyPhase` |
| Consumer range validation: Phase A → Phase B downgrade | `src/core/phases.js:findRangeViolation` |
| Phase B → Phase A promotion when all consumers accept the fix | `src/core/phases.js:applyPhases` |
| Dev-only `probableFalsePositive` for Phase C NO_FIX items | `src/core/phases.js:applyPhases` (lines 100–108) |
| Multi-major conflict detection → Phase C | `src/core/phases.js:classifyPhase` |
| Nested override generation when parent sets are disjoint → Phase B | `src/core/phases.js:promoteMultiMajorToPhaseB` |
| npm `overrides` builder (flat and nested) | `src/ecosystems/npm/overrides.js:buildPhaseAOverrides`, `buildPhaseBOverrides` |
| Direct dep upgrade detection and application | `src/ecosystems/npm/overrides.js:detectDirectDeps`, `applyDirectUpgrades` |
| npm `package-lock.json` v2/v3 parsing with parent-link reconstruction | `src/ecosystems/npm/lock-parser.js:parseLockFile` |
| Dep chain BFS from package to root | `src/ecosystems/npm/lock-parser.js:findDepChain` |
| npm registry version verification (optional, non-blocking) | `src/ecosystems/npm/registry.js:verifyPlanVersions` |
| npm install runner with snapshot/restore rollback | `src/ecosystems/npm/installer.js:runPackageLockUpdate`, `snapshotFiles`, `restoreFiles` |
| Post-install lock-file verification | `src/ecosystems/npm/installer.js:verifyFixVersions` |
| `.mend-manifest.json` idempotency tracking and manual-change detection | `src/ecosystems/npm/installer.js:saveManifest`, `detectManualChanges` |
| Stale override cleanup subcommand | `mendfix.js:runCleanup` |
| Markdown remediation report | `src/core/report.js:generateReport` |
| Confidence/evidence enrichment (with bug — see E.1) | `src/core/confidence.js:enrichWithConfidence` |
| Maven `pom.xml` `dependencyManagement` patching with rollback | `src/ecosystems/maven/pom-writer.js:applyPomPatch` |
| Maven Central registry verification | `src/ecosystems/maven/registry.js:verifyPlanVersions` |
| Renovate PR title parsing (4 formats) | `src/core/renovate-classifier.js:parsePRTitleNew` |
| Renovate PR → `ResolutionItem[]` conversion | `src/core/renovate-builder.js:buildResolutionItems` |
| Per-repo Renovate apply pipeline with optional apply and PR close | `renovate-apply.js:processRepo` |
| Dry-run mode for Mend and Renovate paths | `mendfix.js` and `renovate-apply.js` (`--dry-run` flag) |
| `mendfix analyze / apply / cleanup / renovate` subcommand dispatch | `mendfix.js:main` |
| Backward-compatibility shim | `mend-fix.js` |

---

## C. Partial Capabilities

### C.1 Maven dep-tree analysis

**Status:** MISSING (structurally expected but not started)

- `mendfix.js:329` contains the comment: `"Skipping lock file (Maven dep-tree analysis coming in a future phase)"`
- `applyPhases(resolutionPlan, null)` is called for Maven — `depTree` is always `null`
- `src/ecosystems/maven/dep-tree.js` does not exist
- **Impact:** for every Maven run, all dep-tree-dependent enrichments are disabled:
  - No consumer range validation (no Phase A → Phase B downgrade)
  - No Phase B → Phase A promotion
  - No `probableFalsePositive` detection
  - No `rootParents` field in Phase C output
  - `promoteMultiMajorToPhaseB` is never triggered
- **Risk:** Maven Phase A items may be unsafe — if a consumer pins the dependency to an exact version that does not include the fix, the override is incorrect for that consumer. Without dep-tree analysis, this is never detected.

### C.2 Override lifecycle — remove-if-unnecessary is manual only

**Status:** PARTIALLY IMPLEMENTED

The audit prompt (section 11) requires an automated cycle:
```
apply override → npm install → check if version resolves without override → remove if unnecessary
```
The current implementation:
- `mendfix apply` applies overrides and runs `npm install`
- The remove-if-unnecessary step exists only as a separate `mendfix cleanup` subcommand
- It requires explicit manual invocation after apply; it is not part of the apply pipeline
- Nested overrides are silently skipped in cleanup mode

### C.3 Renovate workflow — npm only

**Status:** PARTIALLY IMPLEMENTED

`renovate-apply.js` is npm-only throughout:
- Hardcodes `package.json` at repo root (`path.join(repoDir, 'package.json')`, line 341)
- Hardcodes `package-lock.json` at repo root (line 342)
- Only imports `npm/registry.js`, `npm/overrides.js`, `npm/installer.js`
- No `detectEcosystem` call; no Maven branch; no `--ecosystem` flag
- Running against a Maven repo silently fails at "package.json not found"

### C.4 Dev/runtime mixed-chain classification (Scenario 8 full)

**Status:** PARTIALLY IMPLEMENTED

- Current: `probableFalsePositive = true` only when **ALL** lock-file entries for a package have `dev: true`
- Mixed chains (one production parent, one dev parent) are left unclassified
- Expected: any package reachable via a production parent chain is **not** a false positive, regardless of other dev-only paths
- The audit prompt (section 14) explicitly requires a regression test for this scenario

### C.5 git-commits.js not wired (Scenarios 15/16)

**Status:** WRITTEN BUT NOT WIRED

- `src/core/git-commits.js` exports `commitPhaseA`, `commitPhaseBC`, `commitFalsePositives`
- No file in the entire codebase imports or calls it
- `mendfix apply` has no `--commit` flag
- Scenarios 15/16 and Scenario 25 (PR-ready state) are blocked on this

### C.6 PR description generation (Scenario 18)

**Status:** MISSING

- `src/core/pr-description.js` does not exist
- `mend-output/pr-description.md` is never generated
- Scenario 25 (PR-ready state) is blocked

### C.7 Post-install verification failure is warning-only

**Status:** INCORRECT (see also E.2)

- `verifyFixVersions` returns an array of failures
- Both `mendfix.js:634-641` and `renovate-apply.js:372-380` log them as warnings only
- Apply is reported as successful even when the lock file shows the vulnerable version was not resolved to the fix version
- **Risk:** false sense of security — the tool applies an override, runs install, and declares success while the CVE remains unpatched

---

## D. Missing Capabilities

### D.1 No automated tests (entire test infrastructure absent)

- No `tests/` directory anywhere in the project
- No `*.test.js` or `*.spec.js` files in the project source tree
- No test framework installed (`package.json` has only `semver` and `xlsx` as dependencies)
- `package.json` `"test"` script runs `node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json` — this is a manual smoke check that references a path outside the repository
- The 26-scenario fixture suite required by `Plans_Prompst/MendAutoFixer_V1_Audit_Gap.md` section 20 is entirely absent
- **Risk:** every code change risks silent regression; no CI gate is possible in this state

### D.2 `src/ecosystems/maven/dep-tree.js` — not started

Referenced in `NEXT_MISSION.md`, `CLAUDE.md`, `docs/ROADMAP.md`. Blocks all of C.1.

### D.3 Mixed-ecosystem report handling

- `src/ecosystems/index.js`: if ANY `LibraryEntry` has `libraryType === 'MAVEN_ARTIFACT'`, the entire run becomes Maven — even if 90% of entries are npm
- A Mend report from a monorepo containing both npm and Maven artifacts is silently mis-routed
- Expected behavior: detect per-entry and route appropriately, or reject mixed reports with a clear error message

### D.4 `providers/index.js` is never called

- `mendfix.js` contains `require('./src/providers/mend')` as a direct import (top of file)
- `src/providers/index.js` exports `detectProvider` and `getParser` — neither is ever called from anywhere in the project
- The provider abstraction described in the architecture is a dead stub
- Adding a second provider (Snyk, SARIF) today requires modifying `mendfix.js` directly rather than registering a provider

### D.5 `repos.json` references non-existent files

`repos.json` contains paths like `"./input/reports/revovate/renovate_*.json"` (7 entries, also a typo: "revovate"). No such directory or files exist under `input/reports/`. `renovate-workflow.js` will fail at runtime with no useful error when it attempts to load these files.

### D.6 `buildCloseComment` returns empty string for some categories

- `src/core/renovate-classifier.js:buildCloseComment` returns `''` for:
  `DISCARDED_MULTI_MAJOR`, `DISCARDED_NO_FIX`, `RENOVATE_INSUFFICIENT`, `NOT_IN_MEND_REPORT`
- In `renovate-workflow.js`, `postComment` is called unconditionally on the result — a blank comment is posted to GitHub for PRs in these categories
- Expected: return a meaningful message for each category, or skip `postComment` when the message is empty

---

## E. Incorrect Behavior

### E.1 `confidence.js` field name bug — broken evidence strings for all range-violation items

- **File:** `src/core/confidence.js:26` and `:67`
- **Current:** `item.rangeViolation.parent` — this field does not exist
- **Actual shape:** `findRangeViolation` in `phases.js` returns `{ consumer, range }`, not `{ parent, range }`
- **Result:** every range-violation item (Phase B due to consumer pin) produces evidence text reading: `"Consumer undefined pins range <range> which does not satisfy <version>"` — the consumer name is always `undefined`
- **Also affected:** `buildAlternative` at line 67 uses the same `.parent` reference, producing corrupted alternative text
- **Note:** `enrichWithConfidence` is called from `renovate-apply.js` but **not** from `mendfix.js`'s Mend apply path — so Mend-path reports are unaffected, but Renovate-path confidence output is always corrupted for range-violation items
- **Fix:** change `.parent` to `.consumer` at lines 26 and 67

### E.2 Verification failure treated as success

- **Files:** `mendfix.js:634-641`, `renovate-apply.js:372-380`
- **Current:** `verifyFixVersions` failures trigger a warning log; the apply function returns success
- **Expected:** if any package's lock-file-resolved version is below the required fix version, the apply should either roll back (safest) or clearly flag the item as unresolved and exit non-zero
- **Risk:** operator sees "Apply complete" and believes the CVE is patched when it is not

### E.3 Manual override removal not detected

- **File:** `src/ecosystems/npm/installer.js:detectManualChanges` (line 97)
- **Current condition:** `if (lastTool && now && now !== lastTool)` — requires `now` to be truthy. If a developer manually removes an override key from `package.json` (setting it to `undefined`), the condition is false and the conflict is not detected
- **Result:** the next `mendfix apply` silently re-applies the override that the developer intentionally removed
- **Fix:** `if (lastTool && (now === undefined || now !== lastTool))`

### E.4 `renovate-workflow.js` produces lower-accuracy phase classifications

- **File:** `renovate-workflow.js:114` — `runMendfixAnalyze` calls `applyPhases(plan)` with no second argument
- **Result:** `depTree` is `undefined`; the entire dep-tree enrichment block in `applyPhases` is skipped
  - Phase A items with consumer range violations are **not** downgraded to Phase B
  - `probableFalsePositive` is never set
  - Nested override promotion never triggers
- **Risk:** Phase A PRs are auto-closed via `--close-prs` when they should have been Phase B or C; engineers receive incorrect guidance

### E.5 `semver.coerce` silently strips prerelease info

- **File:** `src/providers/mend.js:parseFixVersions`
- **Current:** `semver.valid(semver.coerce(version))` — `semver.coerce` strips prerelease/build metadata
- **Example:** Mend fix version `1.2.3-patch1` → stored as `1.2.3`; override applied at `1.2.3` when the actual safe release is `1.2.3-patch1`
- **Risk:** low probability but produces an incorrect override version silently with no log entry

### E.6 `Math.max` called on empty array

- **File:** `src/core/semver-engine.js:buildResolutionPlan`
- **Current:** `Math.max(...entry.cves.map(c => c.score || 0))` — if `cves` is an empty array, this is `Math.max()` which returns `-Infinity`
- `resolveFixVersion` guards against `cves.length === 0` early, but `buildResolutionPlan` can be called with entries that pass other validation but have no CVEs
- **Fix:** `Math.max(0, ...entry.cves.map(c => c.score || 0))`

---

## F. Test Coverage Gaps

**There are zero automated tests.** The following scenarios are completely untested.

### `src/core/semver-engine.js`

| Scenario | Expected result |
|---|---|
| `^6.4.2` consumer, fix `6.5.7` | `SAFE`, `recommendedVersion: '6.5.7'` |
| `6.4.2` exact consumer, fix `6.5.7` | `SAFE`, but `findRangeViolation` returns violation |
| `~6.4.2` consumer, fix `6.5.7` (different minor) | `SAFE`, range violation |
| `^6.x` consumer, fix `7.x` | `MAJOR_BUMP` |
| `>=6.4.0 <7.0.0` consumer, fix `6.5.7` | `SAFE`, no violation |
| Multi-CVE entry: CVE-A needs `6.5.0`, CVE-B needs `6.6.0` | `recommendedVersion: '6.6.0'` |
| `fixVersions: []` for any CVE | `NO_FIX` |
| `cves: []` on entry | Should not crash; `highestCvssScore: 0` |

### `src/core/phases.js`

| Scenario | Expected result |
|---|---|
| Single safe-range item | Phase A |
| Multi-instance same-major (deduplication) | Phase A |
| Range-violation consumer | Phase A → Phase B downgrade |
| All consumers accept fix version | Phase B → Phase A promotion |
| `MAJOR_BUMP` item | Phase C always |
| Multi-major conflict, overlapping parents | Phase C |
| Multi-major conflict, disjoint parents | Phase B, `nestedOverrides` set |
| All lock-file entries `dev: true` | `probableFalsePositive: true` |
| Mixed dev/prod entries | `probableFalsePositive` NOT set |

### `src/core/confidence.js` (after E.1 fix)

| Scenario | Expected result |
|---|---|
| Phase B item with `rangeViolation.consumer = 'pkg-x'` | Evidence contains `"Consumer pkg-x"` |
| Phase C `MAJOR_BUMP` item | Alternative text non-empty, `consumer` not `undefined` |

### `src/ecosystems/npm/lock-parser.js`

| Scenario | Expected result |
|---|---|
| lockfileVersion 2, simple `A → B` | `depTree.get('B')` has `A` as parent |
| lockfileVersion 3, same | Same result |
| lockfileVersion 1 | Clear error thrown |
| Scoped package `@scope/pkg` | Correctly keyed as `@scope/pkg` |
| Nested `node_modules/A/node_modules/B` | `B` entry has `A` as parent |
| Multiple versions of `bar` (under different parents) | Both entries present, correct parents |
| Malformed JSON | Error thrown |
| Missing `packages` key | Error thrown |
| `findDepChain` finds chain | Returns array from root to package |
| `findDepChain` BFS guard triggered | Returns `[]`; warning should be emitted |

### `src/ecosystems/npm/overrides.js`

| Scenario | Expected result |
|---|---|
| Two Phase A items for same package, different versions | Highest version wins |
| Root-only dep (no parents) | `detectDirectDeps` → `directUpgrades` |
| Transitive dep (has parents) | `detectDirectDeps` → `overrideItems` |
| Existing unrelated override in `package.json` | Preserved after merge |
| Phase B item with `nestedOverrides` | Correct nested structure in output |
| `applyDirectUpgrades` on `^1.2.3` dep | Updates to `^<fixVersion>` |

### `src/ecosystems/npm/installer.js`

| Scenario | Expected result |
|---|---|
| `snapshotFiles` / `restoreFiles` round-trip | Files restored to original content |
| `detectManualChanges`: user changed value | Conflict detected |
| `detectManualChanges`: user **removed** key | Conflict detected (after E.3 fix) |
| `verifyFixVersions`: all resolved ≥ fix | Empty failures array |
| `verifyFixVersions`: one resolved < fix | Failure entry for that package |

### `src/providers/mend.js`

| Scenario | Expected result |
|---|---|
| JSON: single finding | One `LibraryEntry` |
| JSON: duplicate CVEs same package | CVEs merged, one entry |
| JSON: `fixVersions: []` | `cves[n].fixVersions: []`, `NO_FIX` downstream |
| JSON: no-fix finding | `upgradeType: 'NO_FIX'` downstream |
| Excel: auto-detect columns | Correct `libraryName`, `currentVersion`, `cve.id` |
| Same finding via JSON vs hypothetical Snyk | Identical `LibraryEntry` shape |

### `src/core/renovate-builder.js`

| Scenario | Expected result |
|---|---|
| PR with `^1.2.3` dep | `currentVersion` correctly coerced |
| PR with `latest` dep, package in lock | Falls back to lock-file version |
| Replace PR (`oldPackageName` present) | `upgradeType: 'MAJOR_BUMP'` |
| Package not in pkg or lock | Pushed to `notFound` |

### `src/core/renovate-classifier.js`

| Scenario | Expected result |
|---|---|
| `"Update dependency jsdoc to v6.0.1"` | `packageName: 'jsdoc'`, `proposedVersion: '6.0.1'` |
| `"chore(deps): update monorepo"` format | `isMonorepoGroup: true` |
| `"[NEUTRAL] Update..."` prefix | Still parses correctly |
| Replace PR title | `oldPackageName` set, `proposedVersion` set |
| Unparseable title | Returns `null` |
| PR matches Phase A item in phased plan | `COVERED_BY_MEND_PHASE_A` |
| `buildCloseComment` for all 8 categories | Non-empty string (after D.6 fix) |

### `src/ecosystems/maven/pom-writer.js`

| Scenario | Expected result |
|---|---|
| Update existing `<version>` in `<dependencyManagement>` | Version replaced |
| Insert new block into existing `<dependencyManagement>` | Block appended correctly |
| No `<dependencyManagement>` section | Section created before `</project>` |
| XML with comment inside `<dependency>` block | Regex behaves correctly or failure is documented |
| Exception thrown during write | POM restored to original; manifest NOT written |

### Integration

| Scenario | Expected result |
|---|---|
| Full Mend npm analyze (8 libs, 22 CVEs) | Phase A: 5, Phase B: 0, Phase C: 3 |
| Full Mend Maven analyze | Phase output without dep-tree enrichments |
| Apply → verify → cleanup cycle | Overrides removed when unnecessary |
| Renovate workflow: PR → phases → apply | Correct phase assignment; overrides applied |
| Idempotency: apply twice | Second run makes no changes |
| Rollback: npm install fails | `package.json` restored; exit non-zero |

---

## G. Renovate Workflow Audit

### Two entry points with different responsibilities (undocumented divergence)

Two separate Renovate-related entry points exist. Neither documentation nor `README.md` clearly explains when to use which:

| | `renovate-workflow.js` | `renovate-apply.js` |
|---|---|---|
| Access via | Direct invocation only | `mendfix renovate` subcommand |
| Input | Mend report + GitHub PRs | GitHub PRs only |
| Applies dep changes? | No | Yes |
| Parses lock file? | No | Yes |
| Uses dep-tree in `applyPhases`? | **No (bug)** | Yes |
| Maven support? | No | No |
| Uses `renovate-classifier.js`? | Yes | Partially (only `parsePRTitleNew`) |
| Closes PRs? | Yes (with `--close-prs`) | Yes (with `--close-prs`) |

These serve different use cases but share no code beyond the GitHub provider. The Renovate module described in `Plans_Prompst/separate-workflow-for-renovate-against-mend.md` is partially implemented across both files without a clear seam.

### `renovate-apply.js` specific gaps

- **npm-only** — no ecosystem detection, no Maven branch (see C.3)
- **Always assumes `package.json` at repo root** — no monorepo support, no `--package-json` flag
- **GitHub token in git URL** (see P0-6)
- **`prNumber`/`prTitle` metadata re-attachment is fragile** — `applyPhases` produces new objects that strip these fields; they are re-attached manually after the fact. Any new field added to `PhasedItem` in the future must also be manually re-attached here.
- **`--include-prs`/`--exclude-prs` flag parser** — if either flag is the last argument with no following value, `argv[++i]` returns `undefined`; `parseInt(undefined)` is `NaN`; the filter silently includes or excludes nothing
- **`buildManualReview` duplicated** — identical function exists in both `mendfix.js` and `renovate-apply.js` with slightly different output format; one is a maintenance liability

### `renovate-workflow.js` specific gaps

- **`applyPhases` called without dep-tree** (E.4) — phase accuracy is reduced; Phase A items that should be Phase B are approved for auto-close
- **No lock file is ever parsed** — dep-tree-dependent features are fully disabled in this workflow
- **`buildCloseComment` returns `''` for 4 categories** (D.6) — blank comments posted to GitHub PRs

### Renovate scenario coverage

| Scenario | Coverage |
|---|---|
| One repo / one PR | Implemented |
| One repo / many PRs | Implemented (paginated fetch) |
| Multiple repositories, isolated state | Implemented (`processRepo` per repo) |
| PR with safe update | Correct only if dep-tree available |
| PR with breaking update (MAJOR_BUMP) | Phase C, manual-review.md |
| PR already applied manually | **No pre-check before applying** |
| Multiple PRs: parent + child dependency | **Not analyzed for interaction** |
| Conflicting PRs | **Not detected; both applied independently** |
| Closed/merged PRs | Handled by `state=open` API filter |
| PR auto-close default | Correctly gated behind `--close-prs` flag |
| Repository recoverable after failed patch | Snapshot/restore handles this |

---

## H. Architecture Gaps

### H.1 `providers/index.js` is a dead abstraction

`mendfix.js` imports `require('./src/providers/mend')` at the top of the file. The `detectProvider` and `getParser` functions in `providers/index.js` are never called by any file in the project. Adding a second provider today requires modifying `mendfix.js` rather than registering a new module. The `getParser` implementation also uses `require('./${provider}')` — a dynamic require with a user-influenceable string, which would be a path-traversal risk if `detectProvider` could return attacker-controlled values; currently it cannot, but the pattern is inherently fragile.

**Required decision:** Either wire `providers/index.js` into `mendfix.js` as the dispatch layer, or explicitly document that direct import is intentional and `providers/index.js` is the registration contract for future providers.

### H.2 Renovate path bypasses `semver-engine.js` without documentation

`renovate-apply.js` takes Renovate's proposed version as `recommendedVersion` directly (via `buildResolutionItems`). `resolveFixVersion` is never called. The two paths share `phases.js`, `overrides.js`, and `installer.js` but diverge at the critical version-determination step. This conscious divergence (Renovate PRs carry no CVE data) is correct in practice, but the data structures look identical, making it invisible to future contributors. If someone adds CVE correlation to the Renovate path, they need to know that `semver-engine.js` must be re-introduced there.

### H.3 `LibraryEntry.cves: []` for Renovate items obscures "no CVE context"

`buildResolutionItems` sets `cves: []`, `cveCount: 0`, `highestSeverity: 'UNKNOWN'`. Inside `phases.js`, the Phase C `NO_FIX` justification is "No fixed version available for any CVE." For a Renovate item where there genuinely is no available fix version, this justification is misleading — the real reason is "Renovate's proposed version is unavailable," not "no CVE fix exists." The phase engine cannot distinguish these cases without a flag or a different field.

### H.4 Lock-parser collapses nested package copies

`parseLockFile` maps every package path to the last segment only:
- `node_modules/foo/node_modules/bar` → key `bar`
- `node_modules/baz/node_modules/bar` → also key `bar`

Both copies merge into the same `Map` entry with a combined parent list. `findRangeViolation` and `findDepChain` operate on this merged set. This produces:
- Range violations reported for consumers that don't actually consume this specific copy of `bar`
- Dep chains that blend paths from different subtrees

Fixing this requires a path-keyed `Map` (e.g., keyed by the full `node_modules/…` path) and updating all callers.

### H.5 No canonical `Finding` model separating discovery from resolution

`LibraryEntry` combines finding information (CVE IDs, severity, reporter-supplied fix versions) with resolution context (current version from lock file). Future providers (Snyk, Dependabot, OSV) would each need to produce this combined structure. The cleaner architecture separates:
- `Finding` — what the provider reports (package, CVEs, fix versions, severity)
- `Resolution` — what the engine determines (current version, recommended version, upgrade type)

This is a P3 concern but is worth naming now to avoid baking provider-specific assumptions deeper into `LibraryEntry`.

### H.6 Report formats are not unified across Mend and Renovate paths

`src/core/report.js` (Mend) and `src/core/renovate-apply-report.js` (Renovate) produce different markdown structures for what is conceptually the same per-package remediation output. There is no documented reason for the difference, and no shared rendering layer. Future changes to the report format must be applied in two places.

---

## I. Documentation Gaps

### I.1 docs/ stub files not deleted

`docs/SESSION_LOG.md` entry (2026-08-11, "Documentation overhaul") states:
> "Deleted 9 files: docs/01_PRODUCT.md … 07_FUTURE.md (empty stubs), docs/decisions.md, docs/Phase_2_Path.md"

All of these files physically exist in the repository:
`docs/01_PRODUCT.md`, `docs/02_WORKFLOW.md`, `docs/03_ARCHITECTURE.md`, `docs/04_IMPLEMENTATION_PLAN.md`, `docs/05_RULES_ENGINE.md`, `docs/06_TASKS.md`, `docs/07_FUTURE.md`, `docs/decisions.md`, `docs/Phase_2_Path.md`

Also present: `docs/Manual_Automation_Next_Phase.md` (13,431 bytes, labelled "historical" in SESSION_LOG but not deleted).

**Recommendation:** `docs/` should contain only `Phase_1_Goal.md`, `ROADMAP.md`, and `SESSION_LOG.md`. All other files in `docs/` should be deleted.

### I.2 `CLAUDE_WORKFLOW.md` references old output filename

Line 19: `"mend-output/phase-c-review.md (generated by mend-fix.js)"`

The file was renamed to `manual-review.md` in session 8 (per `SESSION_LOG.md`). The actual CLI also generates `manual-review.md`. A developer following Phase C triage instructions will look for a file with the wrong name.

**Fix:** Update `CLAUDE_WORKFLOW.md:19` to `manual-review.md`.

### I.3 `package.json` test script references path outside repo

```json
"test": "node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json"
```

`CLAUDE.md` says the file is at `D:\Automation\GH_ui-platform_dev-vulnerability-report.json`. The project's `input/reports/` directory contains the same file as `input/reports/GH_ui-platform_dev-vulnerability-report.json`. The test script will fail on any machine where the file is not at the specific absolute path.

**Fix:** `"test": "node mendfix.js analyze --report input/reports/GH_ui-platform_dev-vulnerability-report.json"`

### I.4 `repos.json` references missing report files

The config file contains paths like `"./input/reports/revovate/renovate_*.json"` (7 entries) with a typo "revovate" and a subdirectory `revovate/` that does not exist. `renovate-workflow.js` will fail at runtime.

### I.5 `x/renovate-workflow.js` is undocumented

An 18,399-byte file at `x/renovate-workflow.js` exists. It is mentioned in no documentation, no README, and no `mendfix` subcommand dispatch. It appears to be an older or alternate version of `renovate-workflow.js` (280 lines). Its status is unknown — historical artifact, alternate implementation, or in-progress work.

**Required decision:** Archive with a note or delete.

### I.6 Two Renovate workflows are undifferentiated in documentation

`README.md` and `CLAUDE.md` do not explain that two separate Renovate entry points exist with different purposes (`renovate-workflow.js` for classify-and-close vs `renovate-apply.js` for apply-changes). A developer discovering the project will not understand which to use or how they relate.

---

## J. Prioritized Backlog

### P0 — Must fix before V1 completion

| ID | Item | File(s) |
|----|------|---------|
| P0-1 | `confidence.js`: `.rangeViolation.parent` → `.rangeViolation.consumer` | `src/core/confidence.js:26,67` |
| P0-2 | Verification failure must trigger rollback (not warning-only) | `mendfix.js:634–641`, `renovate-apply.js:372–380` |
| P0-3 | `detectManualChanges`: detect override removal (not just modification) | `src/ecosystems/npm/installer.js:97` |
| P0-4 | pom-writer: `saveManifest` must not be called before all writes succeed | `src/ecosystems/maven/pom-writer.js:155–170` |
| P0-5 | `renovate-workflow.js` must pass dep-tree to `applyPhases` | `renovate-workflow.js:114` |
| P0-6 | GitHub token must not appear in git clone URL | `renovate-apply.js:102`, `renovate-workflow.js:79` |
| P0-7 | Raise Node engine to `>=18` or guard `fetch` with startup check | `package.json`, `src/providers/github.js`, `src/ecosystems/npm/registry.js`, `src/ecosystems/maven/registry.js` |

### P1 — Required for V1 quality

| ID | Item | File(s) |
|----|------|---------|
| P1-1 | Wire `git-commits.js` into `mendfix apply --commit` (Scenarios 15/16) | `mendfix.js`, `src/core/git-commits.js` |
| P1-2 | Create `src/core/pr-description.js` and wire into `mendfix apply` (Scenario 18) | new file |
| P1-3 | Create `src/ecosystems/maven/dep-tree.js` parsing `mvn dependency:tree` output | new file |
| P1-4 | Wire `providers/index.js` into `mendfix.js` or document as intentional bypass | `mendfix.js`, `src/providers/index.js` |
| P1-5 | Mixed-ecosystem reports: reject with clear error or route per-entry | `src/ecosystems/index.js` |
| P1-6 | `buildCloseComment`: return non-empty string for all 8 categories | `src/core/renovate-classifier.js:buildCloseComment` |
| P1-7 | `renovate-apply.js`: detect ecosystem; add Maven apply path | `renovate-apply.js` |
| P1-8 | `semver-engine.js`: guard `Math.max` against empty CVE array | `src/core/semver-engine.js:buildResolutionPlan` |
| P1-9 | Create test suite skeleton with 21 minimum unit tests | `tests/` (new); `package.json` |
| P1-10 | Fix `package.json` test script to reference file within repo | `package.json` |
| P1-11 | Fix `repos.json` to reference correct report file paths | `repos.json` |
| P1-12 | Update `CLAUDE_WORKFLOW.md:19` from `phase-c-review.md` to `manual-review.md` | `CLAUDE_WORKFLOW.md` |
| P1-13 | Delete docs stub files that SESSION_LOG says were already deleted | `docs/01–07_*.md`, `docs/decisions.md`, `docs/Phase_2_Path.md` |

### P2 — Important but can follow V1

| ID | Item |
|----|------|
| P2-1 | Maven post-install version verification (equivalent of `verifyFixVersions` for pom.xml) |
| P2-2 | Full dev/runtime mixed-chain classification (Scenario 8 full) |
| P2-3 | BFS guard in `findDepChain` should emit a warning when hitting 100-node limit |
| P2-4 | `isAlreadyApplied` should use order-independent deep comparison |
| P2-5 | pom-writer: replace regex XML editing with a proper XML parser (e.g., `xml2js`) |
| P2-6 | pom-writer: XML-escape `groupId`, `artifactId`, `version` before insertion |
| P2-7 | Maven Central registry: raise query limit from 200 rows or paginate |
| P2-8 | npm registry: add concurrency cap and backoff for `verifyPlanVersions` |
| P2-9 | `renovate-apply.js` flag parser: guard against missing value after `--include-prs`/`--exclude-prs` |
| P2-10 | Deduplicate `buildManualReview` between `mendfix.js` and `renovate-apply.js` |
| P2-11 | Automated override-remove cycle: remove if unnecessary post-install |
| P2-12 | Document or delete `x/renovate-workflow.js` |
| P2-13 | Rollback atomicity: use rename-based atomic write for snapshot restore |

### P3 — Future

| ID | Item |
|----|------|
| P3-1 | Lock-parser: path-keyed `DepTree` to correctly represent multiple nested copies |
| P3-2 | Canonical `Finding` model separating discovery from resolution context |
| P3-3 | Full provider extensibility via `providers/index.js` (Snyk, SARIF, Dependabot, OSV) |
| P3-4 | Monorepo support for Renovate apply (multi-root `package.json`) |
| P3-5 | PR conflict detection across multiple Renovate PRs (parent+child interaction) |
| P3-6 | Unified report format across Mend and Renovate paths |

---

## K. Implementation Plan — P0 and P1 Items

---

### P0-1: `confidence.js` field name bug

| | |
|---|---|
| **Problem** | `item.rangeViolation.parent` is always `undefined`; `phases.js` produces `{ consumer, range }` |
| **Current** | `src/core/confidence.js:26`: `item.rangeViolation.parent` — `buildEvidence`<br>`src/core/confidence.js:67`: `item.rangeViolation.parent` — `buildAlternative` |
| **Expected** | Evidence reads: `"Consumer <packageName> pins range <range> which does not satisfy <version>"` |
| **Files** | `src/core/confidence.js` — 2 changes |
| **Implementation** | Replace `.rangeViolation.parent` with `.rangeViolation.consumer` at lines 26 and 67 |
| **Test cases** | 1. Phase B item with `rangeViolation.consumer = 'react'` → evidence contains `"Consumer react"`<br>2. Phase A item → no rangeViolation reference |
| **Acceptance** | Evidence string for range-violation items is non-empty and contains a real package name |
| **Dependencies** | None |
| **Risk** | Low — string-only fix, no logic change |

---

### P0-2: Verification failure must trigger rollback

| | |
|---|---|
| **Problem** | `verifyFixVersions` returns failures; both callers log a warning and continue; apply reports success |
| **Current** | `mendfix.js:634–641`: `if (verifyFailures.length > 0) { console.warn(...) }`<br>`renovate-apply.js:372–380`: same pattern |
| **Expected** | If any package's resolved version < required fix version, call `restoreFiles(snapshots)` and exit non-zero (or mark item as unresolved and escalate) |
| **Files** | `mendfix.js:634–641`, `renovate-apply.js:372–380` |
| **Implementation** | After `verifyFixVersions`: `if (failures.length > 0) { restoreFiles(snapshots); log each failure with recommended action; exit(1) or push to errors[] }` |
| **Test cases** | 1. Install succeeds but lock still has vulnerable version → package.json reverted; non-zero exit<br>2. Install succeeds and lock has fix version → apply succeeds normally |
| **Acceptance** | Exit code non-zero on verification failure; `package.json` unchanged from pre-apply state; output names each unresolved package |
| **Dependencies** | None |
| **Risk** | Medium — changes observable behavior; document as breaking change |

---

### P0-3: Detect manual override removal

| | |
|---|---|
| **Problem** | If a developer removes an override key, `detectManualChanges` does not detect the conflict |
| **Current** | `installer.js:97`: `if (lastTool && now && now !== lastTool)` — `now === undefined` is falsy, skips |
| **Expected** | Removal of a key that was written by the tool is also a conflict |
| **Files** | `src/ecosystems/npm/installer.js:detectManualChanges` |
| **Implementation** | Change condition to: `if (lastTool && (now === undefined \|\| now !== lastTool))` |
| **Test cases** | 1. Manifest has `X: "1.2.3"`, pkg has no `overrides.X` → conflict flagged<br>2. Manifest has `X: "1.2.3"`, pkg has `overrides.X = "1.2.3"` → no conflict<br>3. Manifest has `X: "1.2.3"`, pkg has `overrides.X = "2.0.0"` → conflict flagged |
| **Acceptance** | Conflict message names the removed key and states it will be re-applied |
| **Dependencies** | None |
| **Risk** | Low — additive detection only |

---

### P0-4: pom-writer manifest/pom synchronization on error

| | |
|---|---|
| **Problem** | `saveManifest` at `pom-writer.js:161` executes before remaining write operations; if an exception follows, catch block restores pom.xml but manifest already written |
| **Current** | `applyPomPatch`: try → … → write pom → `saveManifest` → … → return; catch → restore pom |
| **Expected** | Manifest is written only after all operations succeed; on any exception, neither pom nor manifest is in a written state |
| **Files** | `src/ecosystems/maven/pom-writer.js:applyPomPatch` |
| **Implementation** | Move `saveManifest(...)` call to immediately before `return result` at the end of the try block, after all file-write operations |
| **Test cases** | 1. Exception thrown after pom write but before return → `fs.existsSync(.mend-manifest.json)` is false |
| **Acceptance** | `.mend-manifest.json` and `pom.xml` are always in sync (both written or neither written) |
| **Dependencies** | None |
| **Risk** | Low — reordering two statements within the same try block |

---

### P0-5: `renovate-workflow.js` must use dep-tree in `applyPhases`

| | |
|---|---|
| **Problem** | `runMendfixAnalyze` calls `applyPhases(plan)` without a second argument; all dep-tree enrichments are disabled |
| **Current** | `renovate-workflow.js:114`: `const phased = applyPhases(plan)` |
| **Expected** | Lock file parsed and passed as `depTree`; phase assignments match `mendfix analyze` accuracy |
| **Files** | `renovate-workflow.js` |
| **Implementation** | At top: `const { parseLockFile } = require('./src/ecosystems/npm/lock-parser')`. Before `applyPhases`: `const lockPath = path.join(repoDir, 'package-lock.json'); const depTree = fs.existsSync(lockPath) ? parseLockFile(lockPath) : null; const phased = applyPhases(plan, depTree);` |
| **Test cases** | 1. Repo with range-violation consumer: Phase A item downgraded to Phase B when lock file present<br>2. Repo without lock file: Phase A item remains Phase A (dep-tree optional) |
| **Acceptance** | Phase output from `renovate-workflow.js` matches `mendfix analyze` for same repo |
| **Dependencies** | Lock file must be available in cloned repo |
| **Risk** | Low — adding an optional input to an existing call |

---

### P0-6: Remove GitHub token from git clone URL

| | |
|---|---|
| **Problem** | `https://x-access-token:TOKEN@github.com/...` embeds token in process args and potentially in `.git/config` |
| **Current** | `renovate-apply.js:102`: `const cloneUrl = \`https://x-access-token:${token}@github.com/${org}/${repoName}.git\`` |
| **Expected** | Token not in URL; not visible in process list; not stored in `.git/config` |
| **Files** | `renovate-apply.js:102–103`, `renovate-workflow.js:79` |
| **Implementation (recommended)** | Use git environment variables: pass `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=url.https://x-access-token:${token}@github.com/.insteadOf`, `GIT_CONFIG_VALUE_0=https://github.com/` via `spawnSync` env option. Clone with plain `https://github.com/${org}/${repoName}.git`. |
| **Test cases** | 1. `cloneOrPull` spawned process args contain no token string<br>2. `.git/config` after clone contains no token string |
| **Acceptance** | `grep -r 'x-access-token' .git/` returns nothing after clone |
| **Dependencies** | Tested on both Windows (Git for Windows) and Linux |
| **Risk** | Medium — environment variable approach works on git 2.13+; verify minimum git version |

---

### P0-7: Node 16 compatibility — `fetch` not available

| | |
|---|---|
| **Problem** | `fetch` is stable only from Node 18; `package.json` `engines` allows `>=16` |
| **Current** | `src/providers/github.js`, `src/ecosystems/npm/registry.js`, `src/ecosystems/maven/registry.js` all use `fetch` with no guard |
| **Expected** | Clear error on Node 16, or confirmed compatibility |
| **Files** | `package.json` |
| **Implementation** | Update `engines.node` to `">=18"`. Add startup check to `mendfix.js`: `if (parseInt(process.versions.node) < 18) { console.error('Node 18 or higher is required'); process.exit(1); }`. Document in CLAUDE.md and README.md. |
| **Test cases** | 1. Node 16 invocation produces clear error at startup<br>2. Node 18 invocation proceeds normally |
| **Acceptance** | No `ReferenceError: fetch is not defined` at runtime |
| **Dependencies** | None |
| **Risk** | Low — Node 16 EOL was September 2023 |

---

### P1-1: Wire `git-commits.js` into `mendfix apply`

| | |
|---|---|
| **Problem** | `git-commits.js` is fully implemented but never imported or called (Scenarios 15/16 incomplete) |
| **Files** | `mendfix.js`, `src/core/git-commits.js` |
| **Implementation** | Add `--commit` boolean flag to `mendfix apply` argument parser. After `verifyFixVersions` returns success: `const { commitPhaseA, commitPhaseBC, commitFalsePositives } = require('./src/core/git-commits'); await commitPhaseA(projectDir, phaseAItems, ecosystem); await commitPhaseBC(projectDir, phaseBCItems); await commitFalsePositives(projectDir, fpItems);` |
| **Test cases** | 1. `--commit` flag: git commit created with correct message after successful apply<br>2. No `--commit` flag: no git commit created |
| **Acceptance** | `git log --oneline -1` shows tool-generated commit after `mendfix apply --commit` |
| **Dependencies** | P0-2 (verification must pass before committing) |
| **Risk** | Low — function implementations exist; wiring only |

---

### P1-2: Create `src/core/pr-description.js`

| | |
|---|---|
| **Problem** | `mend-output/pr-description.md` never generated; Scenario 18 and Scenario 25 blocked |
| **Files** | `src/core/pr-description.js` (new), `mendfix.js` |
| **Implementation** | `generatePRDescription(phasedPlan, reportMeta) → string`. Content: summary table (CVE count by severity), Phase A table (package, version, upgrade type), Phase B table with reviewer action, Phase C list with manual steps, false-positive list. Wire into `mendfix apply` after `generateReport`, write to `path.join(outDir, 'pr-description.md')`. |
| **Test cases** | 1. Plan with A/B/C items → all sections present in output<br>2. Plan with zero C items → Phase C section absent |
| **Acceptance** | `pr-description.md` exists after `mendfix apply`; parseable as markdown |
| **Dependencies** | None |
| **Risk** | Low — new file, no modifications to existing logic |

---

### P1-3: Create `src/ecosystems/maven/dep-tree.js`

| | |
|---|---|
| **Problem** | Maven `applyPhases` always runs without dep-tree; all enrichments disabled for Java repos |
| **Files** | `src/ecosystems/maven/dep-tree.js` (new), `mendfix.js` |
| **Implementation** | Run `mvn dependency:tree -DoutputType=text` via `spawnSync`. Parse indented text output into `DepTree` (same `Map<name, Entry[]>` shape as `lock-parser.js`). Each `Entry` must carry at minimum: `resolvedVersion`, `dev: false` (Maven has no dev concept), `parents: []`. Wire into `mendfix.js` Maven path: `const depTree = buildMavenDepTree(projectDir); const phased = applyPhases(resolutionPlan, depTree);` |
| **Test cases** | 1. Fixture of `mvn dependency:tree` text output → correct parent-link structure<br>2. Multi-version entry → two entries in map with distinct parents<br>3. `mvn` not on PATH → graceful fallback (null depTree, log warning) |
| **Acceptance** | Maven Phase A items with consumer range violations are downgraded to Phase B |
| **Dependencies** | `mvn` must be on PATH; test with fixture file to avoid requiring live Maven |
| **Risk** | Medium — text parsing of `mvn dependency:tree` output; format varies slightly between Maven versions |

---

### P1-9: Minimum test suite

| | |
|---|---|
| **Problem** | Zero automated tests; no CI gate possible |
| **Files** | `package.json`, `tests/` (new directory tree) |
| **Implementation** | 1. `npm install --save-dev jest` (adds jest to `devDependencies`). 2. Update `package.json` `"test"` script to `"jest"`. 3. Create `tests/fixtures/` with minimal package-lock.json (v3) and package.json fixtures. 4. Create the following test files (21 tests minimum):<br>— `tests/core/semver-engine.test.js` (8 tests: safe, exact-pin, tilde, cross-major, multi-range, multi-CVE, no-fix, empty-cves)<br>— `tests/core/phases.test.js` (6 tests: A, B-downgrade, B-A-promotion, C-MAJOR_BUMP, C-multi-major, dev-false-positive)<br>— `tests/core/confidence.test.js` (2 tests: consumer name in evidence, no undefined)<br>— `tests/ecosystems/npm/lock-parser.test.js` (5 tests: v2 chain, v3 chain, v1 error, scoped package, multi-version) |
| **Test cases** | Each test file covers the scenarios listed in section F |
| **Acceptance** | `npm test` exits 0; all 21 tests pass; test output shows per-test results |
| **Dependencies** | P0-1 must be fixed before confidence tests can pass |
| **Risk** | Low — no source code changes; test infrastructure only |

---

## L. Final V1 Checklist

```
Core engine (npm/Mend path):
[ ] P0-1: confidence.js .rangeViolation.parent → .rangeViolation.consumer (2 lines)
[ ] P0-2: verifyFixVersions failure triggers restoreFiles + non-zero exit, not warning
[ ] P0-3: detectManualChanges detects override removal (not only modification)
[ ] P1-1: git-commits.js wired into mendfix apply --commit (Scenarios 15/16)
[ ] P1-2: pr-description.js created; pr-description.md written after apply (Scenario 18)
[ ] Scenarios 1–17, 19–24, 26: previously declared complete — verified by automated test

Maven path:
[ ] P1-3: src/ecosystems/maven/dep-tree.js created and wired into mendfix.js Maven path
[ ] Maven applyPhases called with depTree (consumer range validation active for Java repos)
[ ] P0-4: pom-writer saveManifest called after all writes succeed (manifest/pom in sync)
[ ] P2-1: Maven post-install version verification (equivalent of verifyFixVersions)

Renovate workflow:
[ ] P0-5: renovate-workflow.js passes lock-file depTree to applyPhases
[ ] P1-6: buildCloseComment returns non-empty string for all 8 categories
[ ] P1-7: renovate-apply.js detects ecosystem; Maven repos handled (or fail with clear error)

Security:
[ ] P0-6: GitHub token removed from git clone URL in both entry points
[ ] P0-7: Node >=18 enforced at startup; package.json engines updated
[ ] P2-6: pom-writer XML-escapes groupId, artifactId, version before insertion (P2)

Architecture:
[ ] P1-4: providers/index.js wired into mendfix.js OR documented as intentional bypass
[ ] P1-5: mixed-ecosystem Mend report rejected with clear error (or per-entry routing)

Testing:
[ ] P1-9: npm test runs jest; 21 minimum unit tests pass
[ ] P1-10: package.json test script references input/reports/GH_ui-platform* (within repo)
[ ] Automated regression: 8 libs, 22 CVEs, Phase A:5 B:0 C:3 as a named jest test

Documentation:
[ ] P1-11: repos.json fixed — correct paths, no typo "revovate"
[ ] P1-12: CLAUDE_WORKFLOW.md:19 updated from phase-c-review.md to manual-review.md
[ ] P1-13: docs/ stub files deleted (01–07_*.md, decisions.md, Phase_2_Path.md,
          Manual_Automation_Next_Phase.md)
[ ] x/renovate-workflow.js archived with note or deleted
[ ] Renovate dual-entry-point explained in README.md or CLAUDE.md
```

---

*Audit complete. No source files were modified during this audit.*
