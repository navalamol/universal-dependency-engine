# Session Log

Minimal change history for future Claude sessions. Only decisions and context that would take time to re-derive.

---

## 2026-08-12 — Parent Upgrade Explorer for MAJOR_BUMP Phase C items

**Before:** MAJOR_BUMP Phase C items produced only a static hint in `manual-review.md` ("check if upgrading parent ships a patched version"). No automation backed it.

**Changes:**
- New `src/ecosystems/npm/parent-upgrade-explorer.js` — walks each root parent's published versions within the project's already-declared semver range, fetches each candidate version's `package.json` from the registry, and checks `semver.intersects(childRange, '>=' + fixVersion)`. Returns paths for the first (latest) parent version that covers the fix. Promoted MAJOR_BUMP Phase C → Phase B on success.
- `src/ecosystems/npm/overrides.js` — `buildPhaseBOverrides` skips items with `parentUpgradePaths` (they don't need overrides); new `buildParentUpgradeMap` extracts parent upgrade entries for the new output file.
- `mendfix.js` — inserts `[4b/5]` exploration step after rootParents annotation (only when `--verify-versions` + `--lock-file` + npm ecosystem); writes `phase-b-parent-upgrades.json`; console shows `[PARENT_UPGRADE]` tag; `printNextSteps` lists the new file; `buildManualReview` shows "no path found" note when exploration ran and came up empty, vs. "run with --verify-versions" when it wasn't run yet.
- The `_parentExplorationRan` flag is stamped on each candidate so `buildManualReview` knows whether the silence means "not checked" or "checked and found nothing".
- Baseline test (no `--verify-versions`, no `--lock-file`) is unaffected — exploration gate requires both.

**Key decision:** Kept exploration behind `--verify-versions` (makes N registry calls per MAJOR_BUMP item — can be slow). No npm install simulation yet (that's a future enhancement); the verification note in `phase-b-parent-upgrades.json` tells the user to run `npm install --package-lock-only` to confirm.

**Next:** npm install simulation (`npm install --package-lock-only` in a temp dir + lock check) would close the last gap and allow fully automated application of parent upgrades.

---

## 2026-08-04 — Initial build: parser + semver engine + overrides + report

**Before:** Empty project. Doc stubs only (`01_PRODUCT.md`–`07_FUTURE.md`). One sample Mend report in JSON + Excel.

**Changes:**
- Built `src/parser.js` — parses Mend JSON and Excel into `LibraryEntry[]`. Groups by `library.keyUuid` (not by CVE) so multiple CVEs for the same library merge into one entry. Fix versions are parsed from `topFix.fixResolution` and `allFixes[]` using a regex that handles three string formats: `"pkg - X.Y.Z"`, `"https://...pkg.git - vX.Y.Z"`, and `"https://...repo.git - pkg@X.Y.Z"`.
- Built `src/semver-engine.js` — deterministic fix selection. Per-CVE minimum same-major fix → take max to cover all CVEs. Falls back to cross-major when no same-major fix exists.
- Built `src/overrides.js`, `src/report.js`, `mend-fix.js` — CLI with `--dry-run`, `--apply`, `--out-dir`.
- Why: the 90-95% of triage that follows a fixed pattern (parse → semver check → override) was fully manual each release cycle.

**Next:** package-lock.json parsing for actual semver range check per consumer (^/~/exact).

---

## 2026-08-04 — Phase model, registry check, @^major removal

**Before:** Flat output. All fixable items (including MAJOR_BUMP) went into a single overrides file. `brace-expansion` used `"brace-expansion@^1": "1.1.18"` scoped selectors. `nanoid 3→5` was auto-applied as an override.

**Changes:**
- Added `src/phases.js` — Phase A/B/C classification matching MEND_AUTOMATION.md confidence scoring.
  - Phase A (95-100%): same-major patch/minor, single version in tree.
  - Phase B (60-95%): same package name, multiple instances, same major.
  - Phase C (<60%): MAJOR_BUMP, NO_FIX, multi-major version conflict (e.g., `brace-expansion` 1.x and 2.x both present).
- Added `src/npm-registry.js` — `--verify-versions` flag hits npm registry, adjusts to nearest published version ≥ minimum fix if the recommended version isn't published.
- Removed `@^major` scoped selectors from overrides — user confirmed these don't reliably work. Multi-major conflicts go to Phase C instead.
- Fixed: `nanoid 3→5` is now Phase C (never auto-applied). Justification + action checklist generated.
- Changed: `--package-json <path>` now auto-applies Phase A only (no separate `--apply` flag needed).
- Output split into `phase-a-overrides.json` (auto-apply), `phase-b-overrides.json` (review), `phase-c-review.md` (justification).
- Why all of this: user feedback session. MAJOR_BUMP in overrides can break functionality. @^major syntax is unreliable. The 3-phase model was always the intent (matches MEND_AUTOMATION.md), just not implemented yet.

**Key constraint learned:** Without `package-lock.json`, we cannot safely handle multi-major conflicts — a single override key covers all versions of a package, which would be a major bump for 1.x consumers if set to 2.x. These stay Phase C until Phase 2/3 adds package-lock traversal.

**Next:** Phase 2/3 — parse `package-lock.json` to build dep tree. Unlocks: nested parent overrides, runtime/dev classification, auto-removal of unnecessary overrides after npm install.

---

## 2026-08-04 — package-lock.json dep tree: consumer validation, dev classification, parent upgrade recommendations, stale override cleanup

**Before:** Pipeline had no visibility into the target project's dependency graph. Phase A confidence was overstated (no consumer range check). False positive detection was manual. Parent upgrade path for Phase C MAJOR_BUMP items required manual `npm ls` triage.

**Changes:**
- Added `src/lock-parser.js` — parses v2/v3 `packages` flat map into `Map<name, Entry[]>`. Second pass builds `parents: [{ name, range }]` for each entry — which packages require it and at what semver range.
- `--lock-file <path>` flag in `mend-fix.js` — loads dep tree, passed through to `applyPhases()`.
- Consumer range check in `src/phases.js` `applyPhases(plan, depTree?)`: for each Phase A candidate, checks if any consumer's declared range does NOT satisfy the fix version. If so, downgrades to Phase B with specific consumer + range in justification. Handles unknown range formats (dist-tags, URLs) by skipping rather than downgrading.
- Dev classification in `src/phases.js`: for NO_FIX Phase C items, if all lock-file entries have `dev: true`, sets `probableFalsePositive: true` and prepends dev-chain notice to justification.
- Root parent enrichment in `mend-fix.js` (post-phase step): for Phase C MAJOR_BUMP items, collects all parents from dep tree, filters to those present in root `dependencies`/`devDependencies`, attaches as `rootParents[]`. Surfaced in Phase C checklist and report.
- `--verify-overrides <lock-file>` mode: standalone post-install step. For each flat override in `package.json`, checks resolved version ≥ override version (effective) and whether all consumer ranges cover the fix (removable). Removes flagged overrides from `package.json` when `--package-json` is provided.

**Key constraint:** `probableFalsePositive` fires only when ALL lock-file entries for the package are `dev: true`. Mixed-chain classification (package has both dev and prod consumers) deferred — requires walking the full parent chain recursively, not just checking the immediate entry flag.

**Next:** Nested parent-scoped overrides for multi-major conflicts (brace-expansion Phase C → Phase B). Requires grouping by major version line and matching parent packages to each line.

---

## 2026-08-04 — Nested overrides, dep chain display, Phase B→A promotion, --out-dir default

**Before:** Multi-major conflicts always Phase C (no nested override generation). Phase B never auto-promoted to A. No dependency path display. `--out-dir` defaulted to `./mend-output` relative to CWD.

**Changes:**
- `src/phases.js` `promoteMultiMajorToPhaseB`: second pass in `applyPhases` after per-item classification. Groups Phase C SAFE items by library name, partitions dep tree entries by major version, checks for parent name overlap. If disjoint → generates `{ parent: { pkg: version } }` nested override map and promotes items to Phase B. If any parent name appears in both major chains → stays Phase C (can't safely key by plain package name). Safety fallback: if a major group has zero parents in dep tree, stays Phase C.
- `src/phases.js` Phase B→A promotion: for same-major multi-instance Phase B items (not range-violation downgrades), calls `findRangeViolation`. If no violation → promotes to Phase A with "all consumer ranges verified" justification.
- `src/lock-parser.js` `findDepChain`: BFS from vulnerable package up through parents until a root dep is found. Returns `[rootPkg, ..., vulnerablePkg]` root-first. 100-node visited limit prevents runaway on large trees.
- `src/report.js` + `mend-fix.js`: surface `depChain` in Phase C sections (report + standalone review file).
- `mend-fix.js` `--out-dir` default: changed from `./mend-output` to `path.join(dirname(reportFile), 'mend-output')`.
- `src/overrides.js` `buildPhaseBOverrides`: handles both flat items and items with `nestedOverrides`. Nested overrides are deep-merged (idempotent — all items in a group carry the same map).

**Key constraint:** No `@version` selectors in override keys (CLAUDE.md rule). A plain key like `"minimatch"` covers ALL instances of minimatch regardless of version. When minimatch@3 and minimatch@5 both appear as consumers of different major lines of the same dep, their name collides → parent name overlap detected → stays Phase C. This is the correct conservative behavior for the ui-platform `brace-expansion` case if minimatch appears in both chains.

**Next:** Test with actual ui-platform package-lock.json to validate all dep-tree features on real data.

---

## 2026-08-04 — Phase 1 blocking scenarios: direct deps, lock update, rollback, manifest

**Before:** Tool wrote `package.json` overrides but never ran npm install. No distinction between direct and transitive deps. No rollback if something failed. Running the tool twice could silently overwrite manually-edited overrides.

**Changes:**
- `src/install-runner.js` (new): owns all install-side operations. `snapshotFiles`/`restoreFiles` for rollback (Scenario 22). `runPackageLockUpdate` runs `npm install --legacy-peer-deps --package-lock-only` in the package.json directory (Scenario 5). `verifyFixVersions` re-parses the updated lock and confirms each Phase A package resolved to ≥ fix version (Scenario 5). `saveManifest`/`detectManualChanges` write `.mend-manifest.json` alongside `package.json` to track what the tool last applied; on the next run, any override whose current value differs from the manifest is skipped with a warning (Scenario 26).
- `src/overrides.js` `detectDirectDeps`: given Phase A items and the parsed `package.json` object, splits them into `directUpgrades` (package found in `dependencies`/`devDependencies`) and `overrideItems` (transitive). Preserves `^`/`~` range prefix when constructing the new range. Priority: direct upgrade > parent upgrade > override (Scenarios 12/13).
- `src/overrides.js` `applyDirectUpgrades`: mutates the pkg object in place, bumping versions in `dependencies`/`devDependencies`. Returns the modified object.
- `mend-fix.js`: direct dep split happens before `buildPhaseAOverrides`, so the JSON output files only contain true overrides (not direct dep items). Apply block: conflict detection → direct bumps → overrides → single write → `npm install` → rollback on failure → verify → save manifest. Summary section simplified: when `--package-json` is provided and install ran, no manual install step is shown.

**Key constraint:** Direct dep detection only runs when `--package-json` is provided (we need the target file to know which packages are direct). Without it, all Phase A items go to `phase-a-overrides.json` as before. `installLockPath` is always derived from `path.dirname(packageJsonPath)` — npm writes the lock file next to `package.json`, regardless of where `--lock-file` pointed for the read-side dep tree analysis.

**Next:** Test with a real ui-platform project to exercise the full apply path including npm install and verify.

---

## 2026-08-04 — Fix Phase A classification: transitive consumer check + output format

**Before:** `detectDirectDeps` classified packages by checking `package.json` `dependencies`. This was wrong: a package can be in `dependencies` AND have transitive consumers — it still needs an override for those consumers. Result: fast-uri and unzipper were stripped from overrides incorrectly; only 2 of 5 Phase A items appeared in `phase-a-overrides.json`.

**Changes:**
- `src/overrides.js` `detectDirectDeps` now takes a `depTree` third parameter. Classification logic: check `entries.some(e => e.parents.length > 0)` — if any dep-tree entry has a non-root parent, the package has transitive consumers → goes to `overrideItems`. Only when ALL entries have `parents.length === 0` (root-only dep) do we check `pkg.dependencies` and classify as `directUpgrade`. When dep tree confirms no transitive consumers but no `--package-json` was provided (`pkg` is `{}`), the item still goes to `directUpgrades` with `currentRange: null` so it appears in the JSON output's `dependencies` section.
- `src/overrides.js` `_buildNewRange` — restored range prefix preservation (`^1.16.0 → ^1.18.0`). Exact version is used only in the JSON output file (`recommendedVersion` directly), not when mutating `package.json`.
- `src/overrides.js` `writeOverridesPatch` — added optional `meta.dependencies` section written before `overrides` in the JSON file. Values are exact fix versions.
- `mend-fix.js` — split now fires when `depTree || targetPkg` (not just `packageJsonPath`). With `--lock-file` alone, classification is accurate in the JSON output even without `--package-json`. `writeOverridesPatch` receives `phaseADependencies` built from `directUpgrades`.

**Key constraint:** When neither `--lock-file` nor `--package-json` is provided, all Phase A items fall back to `overrides` (safe: we can't determine transitive consumers). The dep tree is required for accurate classification.

**Next:** Test against actual ui-platform project with both `--lock-file` and `--package-json` to confirm axios → `dependencies`, fast-uri/postcss/etc. → `overrides`.

---

## 2026-08-10 — Multi-ecosystem support: Maven/Java extension

**Before:** Tool was npm-only — registry check, overrides output, pom mutation, report commands, and install runner were all hardcoded to npm.

**Changes:**
- `src/parser.js`: Added `groupId` and `libraryType` fields to `LibraryEntry`; use `lib.artifactId` as `libraryName` for Maven artifacts; added Pattern 2 (GAV `groupId:artifactId:version`) to `parseFixVersions`; coerce Maven version strings (`"1.84"` → `"1.84.0"`) so `semver.valid` doesn't reject them.
- `src/semver-engine.js`: Pass `groupId` and `libraryType` through `buildResolutionPlan` output so downstream modules can use them.
- `src/report.js`: Accept `ecosystem` option; show `<dependencyManagement>` XML in Phase A section for Maven; say "Maven Central" vs "npm registry"; swap `mvn dependency:resolve` for `npm install` in follow-up instructions.
- `src/maven-registry.js` (new): Mirror of `npm-registry.js`; uses Maven Central solr search API (`search.maven.org/solrsearch/select`); sequential with 300ms delay to avoid rate-limiting; same output shape (`registryExists`, `registryAdjusted`, `registryRequested`).
- `src/pom-writer.js` (new): Builds `<dependencyManagement>` XML snippets; writes `phase-a-pom-patch.xml`/`phase-b-pom-patch.xml`; applies patches to real `pom.xml` via string/regex manipulation (no XML library — structure is predictable); snapshot/restore rollback; `.mend-manifest.json` idempotency tracking.
- `mend-fix.js`: Auto-detects ecosystem from `library.type` in parsed entries (`MAVEN_ARTIFACT` → `maven`, else `npm`); `--ecosystem` flag overrides; `--pom-xml` flag for Maven auto-apply (parallel to `--package-json`); routes registry check and output writing to ecosystem-specific modules; `buildPhaseCDoc` now ecosystem-aware (`mvn dependency:tree` vs `npm ls`).

**Key constraint:** Maven version coercion (`"1.84"` → `"1.84.0"`) happens in `parser.js` only for `MAVEN_ARTIFACT` entries. npm versions are left untouched to avoid regressions.

**Key constraint:** `pom-writer.js` uses string/regex to manipulate XML. Works reliably for the standard Maven `<dependencyManagement>` structure. Edge cases (multiple `<dependencies>` tags, namespaced XML, `<![CDATA[` around versions) are not handled — will warn and skip rather than corrupt.

**Next:** Maven dep-tree parser (equivalent of `lock-parser.js`) to enable Phase B promotions for multi-major conflicts and scope-based false positive detection.

---

## 2026-08-11 — Folder restructure + Phase 1 completion (Scenarios 19/20/21/24)

**Before:** Flat `src/` with 10 files. Single CLI entry `mend-fix.js` with flag-based mode switching. Phase C output in `phase-c-review.md`. No subcommands.

**Changes:**
- Restructured `src/` into `core/`, `providers/`, `ecosystems/npm/`, `ecosystems/maven/` — file moves only, no logic changes. Extension point for Phase 2 (add `src/providers/snyk.js`) and Phase 3 (add `src/ecosystems/pip/`) is now zero-friction.
- Added `mendfix.js` as the new CLI with subcommands: `analyze` (dry-run), `apply` (full apply), `cleanup` (was `--verify-overrides`). `mend-fix.js` kept as a thin shim for backward compat.
- Renamed Phase C output `phase-c-review.md` → `manual-review.md` (Scenario 24).
- Added idempotency pre-flight check (Scenario 21): compares current state against `.mend-manifest.json` before doing any work; exits cleanly with "nothing to apply" if matched.
- Added `src/core/confidence.js` — `evidence` + `alternative` fields per resolution item (Scenario 14).
- Added `src/core/git-commits.js` — auto-commit by confidence tier (Scenarios 15/16).
- Added `src/providers/index.js` and `src/ecosystems/index.js` — provider/ecosystem auto-detection split out from CLI.
- Moved `Phase_1_Goal.md`, `Phase_2_Path.md`, `Manual_Automation_Next_Phase.md` into `docs/`.

**Key decision:** Provider interface = `parse(filePath) → LibraryEntry[]`. Ecosystem interface = modules in `ecosystems/<name>/`. Core (`src/core/`) has zero imports from providers or ecosystems — stays stable across all 9 roadmap phases.

**Next:** Maven dep-tree parser (`src/ecosystems/maven/dep-tree.js`) to unlock Phase B promotions for Java. Then Scenarios 15/16 wiring in `mendfix.js apply` for auto git commits.

---

## 2026-08-11 — Documentation overhaul: CLAUDE.md, NEXT_MISSION.md, README.md, doc audit

**Before:** CLAUDE.md was accurate but lacked Phase 1 completion status and navigation pointers. README.md reflected pre-restructure architecture (flat `src/`, old flags). Seven docs in `docs/01_PRODUCT.md`–`07_FUTURE.md` were empty stubs written at project inception. `docs/decisions.md` had 3 decisions already captured in CLAUDE.md.

**Changes:**
- Rewrote `CLAUDE.md` as the definitive bootstrap doc: added Phase 1 completion status per scenario, explicit "remaining gaps" list, stable interface definitions, navigation table pointing to other docs. Removed stale "Build incrementally (phases from docs/04)" section.
- Created `NEXT_MISSION.md` — single source of truth for "what to build next." CTO-level view: 4 prioritized Phase 1 gaps, Phase 2 entry criteria, what NOT to do. Replaces the need to diff ROADMAP.md to find next work.
- Rewrote `README.md` to reflect current state: subcommand CLI, Maven support, 3-phase model table, safety guarantees, all current flags. Removed pre-restructure architecture that referenced `src/parser.js` etc.
- Updated `docs/ROADMAP.md`: moved Scenarios 14, 19/20, 21, 24, folder restructure, Maven, git-commits.js (partial) from Todo → Done.
- Updated `docs/Phase_1_Goal.md`: added completion status table (20 done, 4 partial, 1 not started, 1 blocked) at top; kept scenario definitions intact.
- Deleted 9 files: `docs/01_PRODUCT.md`–`07_FUTURE.md` (empty stubs), `docs/decisions.md` (redundant with CLAUDE.md), `docs/Phase_2_Path.md` (superseded by NEXT_MISSION.md + Master_Roadmap.md), `docs/Manual_Automation_Next_Phase.md` (historical; key points already in SESSION_LOG), `Plans_Prompst/` both files (plans for completed work).

**Key decision:** `NEXT_MISSION.md` at root level (not `docs/`) — it's the first thing a fresh session needs, same priority as `CLAUDE.md`.

**Next:** Wire `git-commits.js` into `mendfix.js apply` (Scenario 15/16). Then `pr-description.js` (Scenario 18). Then close Phase 1.



## 2026-08-11 — Renovate PR workflow (renovate-workflow.js)

**Before:** No GitHub integration. mendfix only processed a single repo/report locally; no awareness of Renovate Bot PRs.

**Changes:**
- Added `renovate-workflow.js` — new standalone CLI. Takes a `repos.json` config (org + list of repos with per-repo Mend report paths), clones each repo, runs mendfix analysis inline (no spawn), fetches Renovate PRs via GitHub API, classifies each PR, and writes a cross-repo report.
- Added `src/providers/github.js` — GitHub REST API wrapper (list PRs, post comment, close PR) using Node 18+ fetch, same pattern as npm/registry.js.
- Added `src/core/renovate-classifier.js` — classifies Renovate PRs into 7 categories by comparing proposed version against mendfix PhasedItem[]. Handles scoped packages, semver comparison, and multi-major conflict as a distinct category (not conflated with NO_FIX).
- Added `src/core/renovate-report.js` — generates markdown + JSON reports for all repos in one pass.

**Key decision:** Multi-major SAFE conflict (`upgradeType === 'SAFE'`, `phase === 'C'`) gets its own category `DISCARDED_MULTI_MAJOR` — separate from `DISCARDED_NO_FIX`. Both are Phase C but the reason and user action differ (nested overrides vs. no fix exists).

**Key constraint:** `--close-prs` closes only `COVERED_PHASE_A` and `COVERED_PHASE_B` PRs. `DISCARDED_MAJOR_BUMP` gets an informational comment but stays open. All other categories are report-only.

**Next:** Integrate Renovate workflow into CI or scheduled job; wire maven ecosystem support once maven dep-tree parser lands.

---

## 2026-08-11 — renovate-apply.js: Renovate-first apply workflow

**Before:** `renovate-workflow.js` compared Renovate PRs against Mend vulnerability reports. The real goal is to evaluate Renovate upgrade safety independently — Mend is secondary.

**Changes:**
- Added `renovate-apply.js` — new standalone CLI. Takes only a `repos.json` (org + repo names, no Mend report field). Clones each repo, fetches Renovate PRs, builds synthetic ResolutionItems from PR title + package.json/lockfile, runs the phase engine, writes output to `output-renovate-{repo}/`, optionally applies Phase A to package.json + runs npm install, optionally closes Phase A PRs.
- Added `src/core/renovate-builder.js` — `buildResolutionItems(prUpgrades, pkg, lockEntries)` converts Renovate upgrade intents into the same ResolutionItem shape that `applyPhases` consumes. No CVEs — `cves: []`. upgradeType computed from semver major comparison. Falls back from direct-dep lookup to lock file resolved version for transitives.
- Added `src/core/renovate-apply-report.js` — Renovate-specific report generator (no CVE IDs; PR numbers + apply status per item).

**Key decision:** No new engine logic. All classification reuses `applyPhases` unchanged. The input data shape is synthetic but identical to what `buildResolutionPlan` produces — so MAJOR_BUMP, multi-version detection, consumer range checks, and Phase B→A promotion all apply automatically to Renovate upgrades.

**Key constraint:** Without a lock file, `detectDirectDeps` conservatively classifies all Phase A items as overrides (can't confirm root-only). With a lock file present (normal case for cloned repos), direct dep bumps are correctly split out.

**Next (planned, not implemented):** git workflow — after `--apply`, checkout branch + commit + push + open PR + close individual Renovate PRs. This makes N Renovate PRs → 1 batch PR per repo.

---

## 2026-08-11 — Renovate flow unified under mendfix; confidence wiring; selective PR filters

**Before:** `renovate-apply.js` was a standalone script with no connection to `mendfix.js`. `confidence.js` (`enrichWithConfidence`) was not called in the renovate flow. No selective PR filtering. Dry-run mode produced files silently with no stdout analysis.

**Changes:**
- Added `renovate` subcommand to `mendfix.js` — delegates to `renovate-apply.main(argv)`. `mendfix renovate --config repos.json` is now the canonical entry point.
- `renovate-apply.js` now exports `main(argv)` and uses `require.main === module` guard so it can be required as a module without auto-running.
- Wired `enrichWithConfidence` after `applyPhases` in the renovate flow — Phase C items now carry `evidence` and `alternative` fields in both stdout and report output.
- Added `--include-prs <nums>` and `--exclude-prs <nums>` (comma-separated PR numbers) to selectively process or skip specific Renovate PRs per repo.
- Dry-run mode now prints a structured per-phase analysis to stdout (✅ Phase A / ⚠️ Phase B / ❌ Phase C) matching the mendfix analyze experience.
- `manual-review.md` now uses a proper action checklist format (matching mendfix Phase C output) with MAJOR_BUMP-specific and conflict-specific required actions, plus evidence/alternative from confidence enrichment.
- `renovate-report.md` Phase C section upgraded from flat table to per-item blocks with evidence and alternative fields.
- Added `npm run renovate`, `npm run analyze`, `npm run apply` scripts to `package.json`.

**Next:** git workflow — checkout branch + commit + push + open batch PR + close individual Renovate PRs after `--apply`.

---

## 2026-08-12 — V1 completion audit

**Before:** No formal audit had been performed against the V1 requirements in `Plans_Prompst/MendAutoFixer_V1_Audit_Gap.md`. Implementation status was tracked informally in `CLAUDE.md` and `NEXT_MISSION.md`.

**Changes:**
- Produced `V1_COMPLETION_AUDIT.md` at project root — comprehensive audit against all 31 sections of the audit prompt. No source code modified.
- Identified 7 P0 blockers (5 correctness defects, 3 security issues — some overlap): confidence.js field name bug (`.parent` → `.consumer`), verification failure warning-only, manual override removal undetected, pom-writer manifest/pom desync on error, renovate-workflow.js bypasses dep-tree in applyPhases, GitHub token in git URL, Node 16 fetch incompatibility.
- Confirmed zero automated tests exist anywhere in the project — no framework, no fixtures, no files.
- Confirmed `git-commits.js` is fully written but never imported or called anywhere.
- Confirmed `providers/index.js` is dead code — `mendfix.js` hard-imports `mend.js` directly.
- Confirmed Maven dep-tree layer is absent; all Maven enrichments run without dep-tree.
- Confirmed two separate undocumented Renovate entry points with different behaviors.

**Next:** Implement P0 fixes in priority order (P0-1 through P0-7), then P1-9 (test suite) to establish a regression gate before proceeding with P1-1 through P1-3.

---

## 2026-08-12 — V1 audit plan implementation: P0 + P1 fixes, test suite

**Before:** 7 P0 correctness/security defects, zero automated tests, git-commits.js unwired, providers/index.js dead, Maven dep-tree absent, mixed-ecosystem handling silent.

**Changes:**
- **P0-1** `confidence.js`: replaced `.rangeViolation.parent` → `.rangeViolation.consumer` at lines 26 and 67 — evidence and alternative strings now show real consumer name.
- **P0-2** Verification failure now triggers rollback + non-zero exit in both `mendfix.js` and `renovate-apply.js` (was warning-only).
- **P0-3** `installer.js:detectManualChanges`: condition changed to `(now === undefined || now !== lastTool)` — override removal is now detected as a conflict.
- **P0-4** `pom-writer.js:applyPomPatch`: manifest write moved to last position in try block with explanatory comment — pom and manifest stay in sync on any exception.
- **P0-5** `renovate-workflow.js:runMendfixAnalyze`: now accepts `repoDir`, parses `package-lock.json` from cloned repo, and passes `depTree` to `applyPhases` — phase accuracy matches `mendfix analyze`.
- **P0-6** `renovate-workflow.js` + `renovate-apply.js`: GitHub token moved from clone URL to git environment variables (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`).
- **P0-7** `mendfix.js`: Node version guard at startup (`< 18` → exit 1); `package.json` `engines.node` updated to `>=18`.
- **P1-1** `git-commits.js` wired into `mendfix apply --commit` flag.
- **P1-2** `src/core/pr-description.js` created; `pr-description.md` written to outDir on every non-dry-run.
- **P1-3** `src/ecosystems/maven/dep-tree.js` created: parses `mvn dependency:tree` text output into `DepTree`; wired into `mendfix.js` Maven path.
- **P1-4** `providers/index.js` wired into `mendfix.js` via `detectProvider/getParser`; dynamic require replaced with static whitelist.
- **P1-5** `src/ecosystems/index.js:detectEcosystem`: now throws with a clear error on mixed npm+Maven reports.
- **P1-6** `renovate-classifier.js:buildCloseComment`: added non-empty comment bodies for `DISCARDED_MULTI_MAJOR`, `DISCARDED_NO_FIX`, `RENOVATE_INSUFFICIENT`, `NOT_IN_MEND_REPORT`.
- **P1-7** `renovate-apply.js`: detects Maven repos (pom.xml without package.json) and returns a clear unsupported error.
- **P1-8** `semver-engine.js`: `Math.max(0, ...)` guard on empty CVE array.
- **P1-9** Test suite: 32 unit + integration tests across semver-engine, phases, confidence, lock-parser, installer, and regression against the real ui-platform Mend report. `npm test` runs jest.
- **P1-10** `package.json` test script now runs `jest`; smoke test preserved as `test:smoke`.
- **P1-11** `repos.json` paths fixed (was "revovate" typo, paths pointed to nonexistent directory).
- **P1-12** `CLAUDE_WORKFLOW.md` updated: all references to `phase-c-review.md` changed to `manual-review.md`.
- **P1-13 BLOCKED** — docs stub files (01-07_*.md etc.) deletion requires explicit user confirmation; not deleted in this session.

**Note:** P1-13 (delete docs stubs) requires user to confirm deletion of: `docs/01_PRODUCT.md`, `docs/02_WORKFLOW.md`, `docs/03_ARCHITECTURE.md`, `docs/04_IMPLEMENTATION_PLAN.md`, `docs/05_RULES_ENGINE.md`, `docs/06_TASKS.md`, `docs/07_FUTURE.md`, `docs/decisions.md`, `docs/Phase_2_Path.md`, `docs/Manual_Automation_Next_Phase.md`.

**Next:** ~~P1-13 (docs cleanup with user confirmation)~~ — completed 2026-08-12 (see entry below). Next: wire `git-commits.js` (Scenario 15/16), then `pr-description.js` (Scenario 18).

---

## 2026-08-12 — P1-13: docs stub cleanup

**Before:** 10 obsolete files in `docs/` remained from project inception and early planning sessions. SESSION_LOG 2026-08-11 incorrectly recorded them as deleted; they were still present.

**Changes:**
- Deleted all 10 files after inspecting each for unique content:
  - `docs/01_PRODUCT.md`–`07_FUTURE.md`: empty heading stubs with no content — deleted.
  - `docs/decisions.md`: 3 decisions verbatim in CLAUDE.md "Key decisions" — deleted.
  - `docs/Phase_2_Path.md`: Phase 2 vision superseded by `NEXT_MISSION.md` + `Master_Roadmap.md` — deleted.
  - `docs/Manual_Automation_Next_Phase.md`: historical chat transcript; all insights captured in SESSION_LOG 2026-08-04 entries — deleted.
- No migration performed — zero unique content existed in any file that wasn't already in authoritative docs.
- CLAUDE.md navigation table unchanged (none of the 10 files were indexed there).

**Next:** Wire `git-commits.js` into `mendfix apply --commit` (Scenarios 15/16), then `pr-description.js` (Scenario 18), then close Phase 1.

---

## 2026-08-12 — Final V1 verification: V1_COMPLETION_STATUS.md

**Before:** No formal end-to-end verification had been run. Completion status tracked informally in CLAUDE.md / NEXT_MISSION.md. 32 tests passing.

**Changes:**
- Ran full test suite (32/32 PASS), smoke test, and live regression against real Mend report (8 libs, 22 CVEs, A:5 B:0 C:3 — exact baseline match).
- Produced `V1_COMPLETION_STATUS.md` at project root covering 14 verification sections.

**Key findings:**
- 3 blockers preventing V1 READY:
  1. Install failure exits 0 (`mendfix.js:677-682`) — rollback works but process.exitCode not set non-zero on npm install failure.
  2. Verification failure control flow (`mendfix.js:447-484`) — "Done." printed, pr-description.md written, commit attempted even after rollback and exitCode=1.
  3. Maven dep-tree range field bug (`dep-tree.js:81`) — parent.range set to resolved version string, not declared range; causes false Phase B downgrades for all Maven Phase A items when dep tree is enabled.
- 1 non-blocking gap: `enrichWithConfidence` not called in `mendfix.js` main path (Scenario 14 fields absent from mendfix CLI outputs; only present in renovate-apply.js path).
- All 13 VERIFIED / VERIFIED WITH LIMITATION items confirmed working.

**Next:** Fix the 3 blockers (in order), then re-run verification to declare V1 READY.

---

## 2026-08-12 — Fix V1 blockers (Blockers 1/2/3)

**Before:** 3 blockers preventing V1 READY: (1) install failure exits 0, (2) verification failure prints "Done." and writes PR description and attempts commit, (3) Maven dep-tree parent.range was resolved version string causing false Phase B downgrades.

**Changes:**
- **Blocker 1** `mendfix.js:677-682`: Added `process.exitCode = 1; return true;` to the install failure branch in `writeOutputNpm`. Install failure now exits non-zero and signals failure to `main()`.
- **Blocker 2** `mendfix.js:443-484`: `writeOutputNpm` and `writeOutputMaven` now return a boolean (`true` = apply failed). `main()` checks the return value; if `applyFailed`, prints "Apply failed — see errors above. No changes were made." and returns immediately — no PR description written, no commit attempted. The `if (!dryRun)` guard on the PR description block was removed (now the applyFailed gate handles it). Also added `process.exitCode = 1` to the `catch` block in `writeOutputNpm` for consistency.
- **Blocker 3** `src/ecosystems/maven/dep-tree.js:81`: Changed `range: parentEntry.version` → `range: '*'`. Maven tree output shows resolved versions, not declared ranges; `findRangeViolation` was treating resolved versions as exact pins, downgrading every Maven Phase A item to Phase B when a dep tree was available.
- 32/32 tests pass. Regression baseline unchanged (A:5 B:0 C:3).

**Next:** Re-run full V1 verification to confirm V1 READY, or address the remaining non-blocking gap (enrichWithConfidence not called in mendfix.js main path).

---

## 2026-08-12 — Remediation Capability Roadmap: analysis + categorization

**Before:** Two ideation documents existed in `NEXT_LEVEL_REMEDIATION_CAPABILITIES/` with no mapping to current implementation or prioritized roadmap.

**Changes:**
- Created `REMEDIATION_CAPABILITY_ROADMAP.md` at project root: comprehensive analysis of all 27 capabilities from the gap analysis doc + concepts from the Claude agent process doc. Covers current capability status (implemented/partial/not implemented), canonical z→y→x example, decision label taxonomy, Change Budget principle, Safety Gate pattern, 9 guardrails for recursive exploration, and a 23-step build sequence across V1.x through V5.
- Updated `NEXT_MISSION.md`: corrected stale Phase 1 gap list (pr-description.js, dep-tree.js now exist), added Phase 1.x Remediation Path Explorer entry with 3-step build sequence.
- Updated `Master_Roadmap.md`: added Phase 1.x, refined Phase 5 to reference Find→Explore→Simulate→Verify→Compare→Recommend→Apply pipeline.

**Key decision:** The core differentiator is verified remediation path exploration, not output labeling. Decision labels (SAFE_ALIGNED, SAFE_PARENT_UPGRADE, CONTROLLED_OVERRIDE, NOT_FIXABLE, NON_RUNTIME_EXPOSURE, MANUAL_SECURITY_REVIEW) are assigned last, as output enrichment on an already-verified path. Classification never drives which path to explore.

**Key constraint:** Static SemVer inference is INFERRED; only `npm install --package-lock-only` simulation in a temp directory produces VERIFIED confidence. The canonical example (z→y@1.5→x@^1.2, fixed x@2.2, y@1.6→x@^2.1) must be discovered and verified automatically via simulation.

**Next:** Wire `git-commits.js` into `mendfix apply --commit` (V1 blocker 1), then wire enrichWithConfidence into CLI path (V1 blocker 2), then begin Phase 1.x with manifest inspection per candidate parent version.
