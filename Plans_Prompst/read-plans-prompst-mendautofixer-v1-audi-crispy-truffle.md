# Plan: V1_COMPLETION_AUDIT.md

## Context

The user wants a comprehensive audit of the `universal-dependency-engine` project against the
requirements in `Plans_Prompst/MendAutoFixer_V1_Audit_Gap.md`. The deliverable is a single document
`V1_COMPLETION_AUDIT.md` at the project root. No source code changes in this task.

**Key constraint:** The audit document must be skeptical, precise, and actionable. Every gap must
name the exact file, function, current behavior, expected behavior, and recommended fix.

---

## Task

Create `D:\Demo\universal-dependency-engine\V1_COMPLETION_AUDIT.md`

This is a pure write task: all research is done. No source code edits.

---

## Full Audit Findings (pre-verified)

### A. Executive Summary

The core npm/Mend remediation engine (semver-engine → phases → overrides → install → report) is
approximately 90% complete and functionally sound for the happy path. The Renovate workflow is
partially functional but npm-only and diverges from the Mend path in ways that will create
long-term maintenance problems. Maven support exists structurally but is missing its dep-tree
layer, disabling all phase-enrichment logic for Java repos.

The single largest structural gap is **zero automated tests** — no test framework, no fixtures,
no unit tests, no integration tests exist anywhere in the project. The "test" script in
`package.json` is a manual smoke-check against a hardcoded path outside the repo.

**Five correctness defects** can produce wrong or misleading recommendations in production today:
1. `confidence.js` field name bug produces broken evidence strings for all range-violation items
2. Post-install verification failure is warning-only — a CVE that survives remediation is not
   escalated and is not rolled back
3. Manual override removal is not detected — silently re-applies on next run
4. `applyPhases` in `renovate-workflow.js` is called without a dep-tree, producing less accurate
   phase assignments than the Mend path for the same packages
5. `providers/index.js` abstraction is unused; `mendfix.js` hard-imports `src/providers/mend.js`
   directly, breaking the provider-agnostic architecture

**Three security issues:**
1. GitHub token embedded in git clone URL (logs token in process args and potentially `.git/config`)
2. `fetch` used on Node ≥16 but only stable on Node ≥18; Node 16 throws `ReferenceError`
3. Maven pom values written directly into XML without escaping — potential XML injection for
   non-standard Maven coordinates

---

### B. Implemented Capabilities (evidence-backed)

- Mend JSON and Excel parsing → `LibraryEntry[]` (`src/providers/mend.js`)
- SemVer fix resolution: same-major minimum safe version, cross-major fallback, no-fix handling
  (`src/core/semver-engine.js`)
- Phase A/B/C classification with justifications (`src/core/phases.js`)
- Consumer range validation (A→B downgrade when a consumer pin doesn't satisfy fix version)
- Phase B→A promotion when dep-tree shows all consumers accept the fix version
- Dev-only `probableFalsePositive` detection for Phase C NO_FIX items
- Multi-major conflict detection; nested override generation when parent sets are disjoint
  (promotes Phase C multi-major to Phase B)
- npm `overrides` and direct dep bump application (`src/ecosystems/npm/overrides.js`)
- npm `package-lock.json` v2/v3 parsing with parent-link reconstruction
  (`src/ecosystems/npm/lock-parser.js`)
- npm registry version verification (optional, non-blocking) (`src/ecosystems/npm/registry.js`)
- npm install runner with snapshot/restore rollback on failure (`src/ecosystems/npm/installer.js`)
- Post-install lock-file verification (`verifyFixVersions`)
- `.mend-manifest.json` for idempotency and manual-change detection
- Stale override cleanup (`mendfix cleanup` subcommand)
- Markdown remediation report (`src/core/report.js`)
- Confidence/evidence enrichment (`src/core/confidence.js`) — **with bug, see E.1**
- Maven `pom.xml` `dependencyManagement` patching (`src/ecosystems/maven/pom-writer.js`)
- Maven Central registry verification (`src/ecosystems/maven/registry.js`)
- Renovate PR title parsing and classification (`src/core/renovate-classifier.js`)
- Renovate PR → ResolutionItem conversion (`src/core/renovate-builder.js`)
- Per-repo Renovate apply pipeline with Phase A/B/C output, optional apply, optional PR close
  (`renovate-apply.js`)
- Dry-run flag for both Mend and Renovate paths
- `mendfix.js` `analyze` / `apply` / `cleanup` / `renovate` subcommand dispatch

---

### C. Partial Capabilities

**C.1 Maven dep-tree analysis**
- File: `mendfix.js:329`, `src/ecosystems/maven/` (no `dep-tree.js` exists)
- Current: `applyPhases(resolutionPlan, null)` — dep-tree parameter always null for Maven
- Missing: `maven/dep-tree.js` that parses `mvn dependency:tree` output into `DepTree`
- Impact: No consumer range validation, no dev classification, no Phase B→A promotion,
  no `probableFalsePositive` detection, no `rootParents` in Phase C output — for all Maven runs
- Risk: Maven Phase A items may be unsafe (override breaks a consumer that pins the version)

**C.2 Override lifecycle — remove-if-unnecessary step is manual only**
- File: `mendfix.js` (cleanup subcommand), `src/ecosystems/npm/installer.js`
- Current: temporary→permanent decision must be made manually via `mendfix cleanup` after apply
- Missing: automated post-install check that tries removing each override and re-running
  `npm install --package-lock-only` to see if the fix version holds without the override
- Risk: unnecessary overrides remain in production `package.json` indefinitely; the audit
  prompt describes this as a required automated cycle, not a separate command

**C.3 Renovate workflow — npm only**
- File: `renovate-apply.js`
- Current: hardcodes `package.json`, `package-lock.json`, `npm/registry.js`, `npm/overrides.js`
  throughout; no `detectEcosystem` call; no Maven branch anywhere
- Missing: ecosystem detection at repo level; Maven apply path for repos without `package-lock.json`
- Risk: Renovate processing silently fails on Maven repos (cannot find `package.json`)

**C.4 Dev/runtime mixed-chain classification (Scenario 8 full)**
- File: `src/core/phases.js:100-108`, `src/ecosystems/npm/lock-parser.js`
- Current: `probableFalsePositive = true` only when ALL lock-file entries for the package
  have `dev: true`. Mixed chains (one prod parent, one dev parent) are unclassified.
- Expected: if any parent chain reaches a production dep, it is NOT a false positive
- Risk: a package with a mixed chain is left unclassified when it should be clearly flagged
  as production-reachable

**C.5 git-commits.js not wired**
- File: `src/core/git-commits.js`, `mendfix.js`
- Current: `git-commits.js` is fully written but not imported anywhere; Scenarios 15/16 incomplete
- Missing: `--commit` flag in `mendfix apply`, calls to `commitPhaseA`, `commitPhaseBC`,
  `commitFalsePositives`
- Risk: none for correctness, but Scenarios 15/16 and the PR-ready state (Scenario 25) are blocked

**C.6 PR description generation (Scenario 18)**
- File: `src/core/pr-description.js` — does not exist
- Missing: generates `mend-output/pr-description.md` with CVE summary table
- Risk: Scenario 25 (final PR-ready state) is blocked; no audit trail for PR authors

**C.7 Post-install verification failure is warning-only**
- File: `mendfix.js:634-641`, `renovate-apply.js:372-380`
- Current: `verifyFixVersions` failures are logged as warnings; the apply succeeds even if the
  lock file shows the vulnerable version was not resolved to the fix version
- Expected: verification failure should either roll back the override (it wasn't effective) or
  escalate the item to Phase C for manual review
- Risk: **false sense of security** — the tool reports "applied successfully" while the CVE
  remains unpatched in the dependency tree

---

### D. Missing Capabilities

**D.1 No automated tests at all**
- Current: `package.json` "test" script runs a manual smoke check against a hardcoded path
  outside the repo; zero test files, zero fixtures, no test framework installed
- Required: full `tests/` suite per audit prompt section 20 (26 fixture scenarios)
- Risk: every code change risks silent regression; no CI gate possible

**D.2 Maven dep-tree.js**
- File: does not exist; referenced in `NEXT_MISSION.md`, `CLAUDE.md`, `docs/ROADMAP.md`
- Blocks: C.1 above; also blocks Maven Phase B for all downstream uses

**D.3 Mixed-ecosystem report handling**
- File: `src/ecosystems/index.js`
- Current: if ANY entry has `libraryType === 'MAVEN_ARTIFACT'`, the entire run becomes Maven,
  even if 90% of entries are npm
- Expected: detect per-entry, route to appropriate ecosystem writer, or reject mixed reports
  with a clear error
- Risk: Mend reports that mix npm and Maven artifacts (possible for monorepos) are mis-routed

**D.4 `providers/index.js` never called**
- File: `src/providers/index.js`, `mendfix.js`
- Current: `mendfix.js` imports `require('./src/providers/mend')` directly; `providers/index.js`
  is dead code; `detectProvider`/`getParser` are never invoked
- Expected: `mendfix.js` should call `detectProvider` to select the correct parser by format
- Risk: adding a second provider (Snyk, SARIF) requires modifying `mendfix.js` directly rather
  than registering a new provider — breaks the provider abstraction entirely

**D.5 repos.json references missing report files**
- File: `repos.json`
- Current: config references `./input/reports/revovate/renovate_*.json` (7 files) in a
  `revovate/` subdirectory that does not exist; also typo "revovate"
- Risk: `renovate-workflow.js` will fail to load these files at runtime with no useful error

**D.6 `buildCloseComment` returns empty string for some categories**
- File: `src/core/renovate-classifier.js:buildCloseComment`
- Current: categories `DISCARDED_MULTI_MAJOR`, `DISCARDED_NO_FIX`, `RENOVATE_INSUFFICIENT`,
  `NOT_IN_MEND_REPORT` all return `''`; caller still invokes `postComment('')` which posts
  a blank comment to GitHub
- Expected: either return a meaningful message or skip `postComment` for these categories

---

### E. Incorrect Behavior (can produce unsafe or misleading recommendations)

**E.1 confidence.js field name bug — broken evidence strings**
- File: `src/core/confidence.js:26` and `:67`
- Current: `item.rangeViolation.parent` — field does not exist; `findRangeViolation` in
  `phases.js` returns `{ consumer, range }`, not `{ parent, range }`
- Result: evidence string always reads "Consumer `undefined` pins range..." for all range-
  violation items; alternative text also corrupted
- Fix: change `.parent` to `.consumer` in both lines

**E.2 Verification failure is warning-only (also listed in C.7)**
- See C.7 — classified as correctness risk here because a CVE not resolved by the override
  is silently left in place

**E.3 Manual override removal not detected**
- File: `src/ecosystems/npm/installer.js:detectManualChanges:97`
- Current: conflict check is `lastTool && now && now !== lastTool` — if the user deletes an
  override entirely, `now` is `undefined`, condition is false, tool re-applies silently
- Fix: also check `lastTool && now === undefined` → flag as "user removed override, re-applying"
  or skip with a warning

**E.4 `renovate-workflow.js` runs `applyPhases` without dep-tree**
- File: `renovate-workflow.js:114` — `runMendfixAnalyze` calls `applyPhases(plan)` (no depTree)
- Result: Phase A items that have consumer range violations are NOT downgraded to Phase B;
  range-violation enrichment, dev classification, and nested-override promotion are all disabled
- This means Phase A output from `renovate-workflow.js` may include items that would be
  classified Phase B or C by the Mend path for the same packages
- Fix: pass lock-file-derived depTree to `applyPhases` in this workflow, same as `renovate-apply.js`

**E.5 `semver.coerce` drops prerelease info silently**
- File: `src/providers/mend.js:parseFixVersions`
- Current: `semver.valid(semver.coerce(version))` strips prerelease/build metadata
- Example: Mend fix version `1.2.3-patch1` becomes `1.2.3`; the tool may apply an override for
  `1.2.3` when the actual safe version is `1.2.3-patch1` (a different artifact)
- Risk: low probability but produces an incorrect override version silently

**E.6 `Math.max(...[])` = `-Infinity` for empty CVE list**
- File: `src/core/semver-engine.js:buildResolutionPlan`
- Current: no guard before `Math.max(...entry.cves.map(c => c.score || 0))`
- If a `LibraryEntry` with `cves: []` reaches this code, `highestCvssScore` = `-Infinity`
- `resolveFixVersion` has an early return for `cves.length === 0`, so the crash path is guarded
  there, but a provider could return an entry that passes `parseReport` with empty cves
- Fix: `Math.max(0, ...entry.cves.map(c => c.score || 0))`

---

### F. Test Coverage Gaps

**F.1 No automated tests exist (zero).**

Every scenario below is completely untested:

**semver-engine.js:**
- Safe range: `^6.4.2` consumer, fix `6.5.7` → SAFE
- Exact pin: `6.4.2` consumer, fix `6.5.7` → range violation
- Tilde range: `~6.4.2`, fix `6.5.7` (different minor) → range violation
- Cross-major: `^6.x` consumer, fix `7.x` → MAJOR_BUMP
- Multiple ranges: `>=6.4.0 <7.0.0` consumer, fix `6.5.7` → SAFE
- Multi-CVE: fix must cover all CVEs simultaneously
- No-fix CVE: `fixVersions: []` → NO_FIX
- Empty CVE list: `cves: []` should not crash

**phases.js:**
- Phase A single version, safe range
- Phase A multi-same-major (deduplicated)
- Phase A→B downgrade (range violation found)
- Phase B→A promotion (all ranges accept fix)
- Phase C MAJOR_BUMP
- Phase C multi-major conflict
- Multi-major → Phase B nested override promotion (disjoint parents)
- Multi-major stays Phase C (overlapping parents)
- probableFalsePositive: all-dev entries
- probableFalsePositive NOT triggered: mixed dev/prod entries

**confidence.js:**
- After fix E.1: evidence string contains `consumer` name for range violations
- alternative text for MAJOR_BUMP, NO_FIX, probableFalsePositive, nested override

**lock-parser.js:**
- Lockfile v2 simple tree
- Lockfile v3 simple tree
- Lockfile v1 → clear error
- Scoped package `@scope/pkg`
- Nested `node_modules/parent/node_modules/child`
- Multiple versions of same package (different parents)
- Missing package entry
- Malformed lockfile (invalid JSON, missing `packages` key)
- findDepChain finds chain correctly
- findDepChain returns [] when not found (BFS guard triggered — should emit warning)

**overrides.js:**
- buildPhaseAOverrides: deduplication picks highest version
- detectDirectDeps: root-only dep → directUpgrade, transitive dep → override
- applyOverridesToPackageJson: merges without overwriting existing unrelated overrides
- buildPhaseBOverrides: nested override structure
- applyDirectUpgrades: updates `^` range, `~` range, exact pin correctly

**installer.js:**
- snapshotFiles/restoreFiles round-trip
- detectManualChanges: user CHANGED value → detected
- detectManualChanges: user REMOVED override → currently NOT detected (E.3)
- verifyFixVersions: fix version resolved → pass
- verifyFixVersions: vulnerable version remains → failure

**mend.js:**
- JSON report: single finding, multiple findings
- JSON report: duplicate CVEs same package
- JSON report: missing fixVersions
- JSON report: no-fix finding
- Excel report: auto-detect columns
- Provider produces identical LibraryEntry regardless of source (same finding = same output)

**renovate-builder.js:**
- PR with `^range` dep: coerces to semver correctly
- PR with `latest` dep: should fall back to lockfile
- Replace PR → MAJOR_BUMP
- Package not found in pkg or lock → notFound list

**renovate-classifier.js:**
- parsePRTitleNew: standard "Update dependency X to vY"
- parsePRTitleNew: monorepo group format
- parsePRTitleNew: [NEUTRAL] prefix, chore(deps): prefix
- parsePRTitleNew: replace PR
- parsePRTitleNew: unparseable title → null
- classifyPRs: PR matches Phase A → COVERED_BY_MEND_PHASE_A
- classifyPRs: duplicate PRs same package
- buildCloseComment: returns non-empty for all categories (after D.6 fix)

**maven/pom-writer.js:**
- Update existing version in `<dependencyManagement>`
- Insert new entry into existing `<dependencyManagement>`
- Insert `<dependencyManagement>` section when absent
- XML with comment inside `<dependency>` block (fragile path)
- Rollback on patch failure

**integration tests:**
- Full Mend npm analyze → phase output matches expected (the current manual smoke test, automated)
- Full Mend Maven analyze → phase output (no dep-tree enrichments expected currently)
- Full apply → lock file verify → cleanup cycle
- Renovate workflow: PR → phases → apply → verify
- Idempotency: run apply twice → no second-run changes
- Rollback: npm install failure → package.json restored

---

### G. Renovate Workflow Audit

**Architecture divergence (critical):**
Two separate Renovate-related entry points exist:
- `renovate-workflow.js` (280 lines): classify PRs against Mend report, comment/close PRs
  (does NOT apply dependency changes; does NOT parse lock file; does NOT fully use dep-tree)
- `renovate-apply.js` (597 lines): apply Renovate PRs as dependency changes (no Mend report
  required; fully uses dep-tree; npm-only; does NOT use renovate-classifier.js for classification)

These serve different use cases but are not integrated. Documentation does not clearly explain
when to use which, and `mendfix renovate` dispatches to `renovate-apply.js` only.

**renovate-apply.js gaps:**
- npm-only throughout (D.3, C.3)
- Always assumes `package.json` at repo root (no monorepo support, no `--package-json` flag)
- GitHub token embedded in git URL (security issue, see security section)
- After `applyPhases`, metadata fields `prNumber`/`prTitle` are manually re-attached because
  `applyPhases` strips them — fragile contract; adding new fields to `PhasedItem` requires also
  updating this re-attachment code
- `--include-prs`/`--exclude-prs` flag parser: if the flag is the last arg with no value,
  `argv[++i]` can go out of bounds silently
- PR close comment is hardcoded per category; no user-configurable templates
- `buildManualReview` function duplicated between `mendfix.js` and `renovate-apply.js`
  (slightly different output format)

**renovate-workflow.js gaps:**
- `runMendfixAnalyze` (line 114) calls `applyPhases(plan)` without a lock file or dep-tree
  (see E.4 — phase accuracy reduced)
- No lock file is ever parsed in this file; all dep-tree-dependent enrichments are disabled
- Same GitHub token-in-URL pattern as renovate-apply.js
- `buildCloseComment` returns `''` for categories `DISCARDED_MULTI_MAJOR`,
  `DISCARDED_NO_FIX`, `RENOVATE_INSUFFICIENT`, `NOT_IN_MEND_REPORT` (see D.6)

**Scenario coverage gaps:**
- One repo / many PRs: implemented (paginated fetch, no artificial limit)
- Multiple repositories: implemented (per-repo isolation in renovate-apply.js)
- PR with safe update: classified correctly if dep-tree is present; **less accurate if not**
- PR with breaking update (MAJOR_BUMP): Phase C, manual-review.md
- PR already applied: no pre-check in renovate-apply.js before applying overrides
- Multiple PRs affecting related deps (parent+child): not analyzed for dependency between PRs
- Conflicting PRs: not detected; both applied independently
- Closed/merged PRs: GitHub API `state=open` filter handles this correctly
- PR auto-close default: correctly gated behind `--close-prs` flag

---

### H. Architecture Gaps

**H.1 `providers/index.js` is a dead abstraction**
`mendfix.js` imports `require('./src/providers/mend')` directly. The `detectProvider`/`getParser`
functions in `providers/index.js` are never called. Adding a second provider (Snyk, SARIF) today
would require modifying `mendfix.js` rather than registering it.

**H.2 `semver-engine.js` is never invoked in the Renovate path**
In `renovate-apply.js`, Renovate's proposed version is taken as `recommendedVersion` directly
(via `buildResolutionItems`). `resolveFixVersion` is never called. The Renovate path trusts
Renovate's version without independent CVE-coverage verification. This is acceptable today
(Renovate PRs don't carry CVE data), but the architecture does not make this conscious divergence
visible — the data structures look identical but the version-resolution contract differs.

**H.3 `LibraryEntry.cves` is always empty for Renovate items**
`buildResolutionItems` sets `cves: []`, `cveCount: 0`, `highestSeverity: 'UNKNOWN'`. This means
`phases.js` cannot distinguish "no CVE data" from "no CVEs" and `semver-engine.js` fallback
paths produce `NO_FIX` for an entry where there is no fix only because there were no CVEs to
begin with. Phase classification for Renovate items with no available fix version will read as
`NO_FIX → Phase C` when the correct classification is "Renovate suggests this version,
no CVE context available."

**H.4 Lock-parser path collapse for nested packages**
`parseLockFile` maps every nested package path to just the last package name
(`node_modules/foo/node_modules/bar` → `bar`). Two different nested copies of `bar` under
different parents merge into the same `Map` entry with a combined parent list. `findRangeViolation`
and `findDepChain` then operate on the merged parent set. This can produce:
- A range violation reported for a consumer that doesn't actually depend on this copy of `bar`
- A dep chain that mixes paths from different subtrees
This is a correctness limitation that would require a path-keyed data structure to fix.

**H.5 No canonical "Finding" model separating finding from resolution**
The current `LibraryEntry` type combines finding information (CVE IDs, severity, fix versions
from a report) with resolution context (current version from lock file). For a multi-provider
future (Mend + Renovate + Snyk), each provider would need to produce a structurally identical
finding model. Currently, Mend produces full `LibraryEntry` while Renovate produces a synthetic
`ResolutionItem` that bypasses `semver-engine.js`. These diverge at the data-model level,
making future provider unification harder.

---

### I. Documentation Gaps

**I.1 docs/ stub files not deleted**
`docs/SESSION_LOG.md` entry (2026-08-11) says 9 stub files were deleted. They physically exist:
`01_PRODUCT.md`, `02_WORKFLOW.md`, `03_ARCHITECTURE.md`, `04_IMPLEMENTATION_PLAN.md`,
`05_RULES_ENGINE.md`, `06_TASKS.md`, `07_FUTURE.md`, `decisions.md`, `Phase_2_Path.md`

**I.2 CLAUDE_WORKFLOW.md references old filename**
Line 19: `mend-output/phase-c-review.md` — file was renamed to `manual-review.md` in session 8.
Users following Phase C triage instructions will look for the wrong filename.

**I.3 `package.json` test script points outside repo**
`"test": "node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json"`
This path is hardcoded outside the project (`../` from project root). CLAUDE.md says the file
is at `D:\Automation\GH_ui-platform_dev-vulnerability-report.json`. The test will fail on any
machine that doesn't have the file at that specific location. Should be `input/reports/GH_ui-platform_dev-vulnerability-report.json`.

**I.4 `repos.json` references non-existent report files**
Config contains paths like `./input/reports/revovate/renovate_*.json` (7 entries). No such
directory or files exist. The `renovate-workflow.js` runtime will fail to read them.

**I.5 `x/renovate-workflow.js` undocumented**
An 18,399-byte file at `x/renovate-workflow.js` is never mentioned in any documentation.
It appears to be an older or alternate version of the workflow. Should be explicitly documented
as historical/archived or deleted.

**I.6 Competing remediation report format**
`src/core/report.js` (Mend path) and `src/core/renovate-apply-report.js` (Renovate path) produce
different markdown formats for what is conceptually the same information. No documentation
explains why the formats differ or which is authoritative.

---

### J. Prioritized Backlog

**P0 — Must fix before V1 completion**

| ID | Item | File(s) |
|----|------|---------|
| P0-1 | confidence.js field name bug: `.parent` → `.consumer` | `src/core/confidence.js:26,67` |
| P0-2 | Verification failure must trigger rollback or Phase C escalation, not just a warning | `mendfix.js:634`, `renovate-apply.js:372` |
| P0-3 | Manual override removal not detected in `detectManualChanges` | `src/ecosystems/npm/installer.js:97` |
| P0-4 | Post-install pom-writer manifest/pom out-of-sync on error | `src/ecosystems/maven/pom-writer.js:155-170` |
| P0-5 | `renovate-workflow.js` must pass dep-tree to `applyPhases` or clearly document that it doesn't | `renovate-workflow.js:114` |
| P0-6 | GitHub token must not be embedded in git clone URL | `renovate-apply.js:102`, `renovate-workflow.js:79` |
| P0-7 | `fetch` Node 16 incompatibility — either raise min version to 18 or add polyfill | `package.json`, `src/providers/github.js`, `src/ecosystems/npm/registry.js`, `src/ecosystems/maven/registry.js` |

**P1 — Required for V1 quality**

| ID | Item | File(s) |
|----|------|---------|
| P1-1 | Wire `git-commits.js` into `mendfix apply` with `--commit` flag (Scenarios 15/16) | `mendfix.js`, `src/core/git-commits.js` |
| P1-2 | Create `src/core/pr-description.js` (Scenario 18) | new file |
| P1-3 | Create `src/ecosystems/maven/dep-tree.js` using `mvn dependency:tree` output | new file |
| P1-4 | `providers/index.js` must be wired into `mendfix.js` (or documented as intentionally bypassed) | `mendfix.js`, `src/providers/index.js` |
| P1-5 | Mixed-ecosystem reports: detect and route per-entry or reject with clear error | `src/ecosystems/index.js` |
| P1-6 | `buildCloseComment` must return non-empty string for all categories | `src/core/renovate-classifier.js:buildCloseComment` |
| P1-7 | Renovate workflow ecosystem detection: route to Maven path when no `package.json` | `renovate-apply.js` |
| P1-8 | `Math.max(...[])` guard for empty CVE list | `src/core/semver-engine.js:buildResolutionPlan` |
| P1-9 | Create test suite skeleton + 10 minimum unit tests covering the core correctness path | `tests/` (new) |
| P1-10 | Fix `package.json` test script to reference `input/reports/` within repo | `package.json` |
| P1-11 | `repos.json` missing report files — create files or fix paths | `repos.json` |
| P1-12 | CLAUDE_WORKFLOW.md rename `phase-c-review.md` → `manual-review.md` | `CLAUDE_WORKFLOW.md:19` |
| P1-13 | Delete or archive doc stubs that SESSION_LOG says were deleted | `docs/01–07_*.md`, `docs/decisions.md`, `docs/Phase_2_Path.md` |

**P2 — Important but can follow V1**

| ID | Item |
|----|------|
| P2-1 | Maven post-install version verification (equivalent of `verifyFixVersions` for pom.xml) |
| P2-2 | Full dev/runtime mixed-chain classification (Scenario 8 full) |
| P2-3 | BFS guard in `findDepChain` should emit a warning when truncating at 100 nodes |
| P2-4 | `isAlreadyApplied` key-order independence (use sorted JSON.stringify or deep-equal) |
| P2-5 | pom-writer: replace regex XML editing with a proper XML parser (e.g., `xml2js`) |
| P2-6 | pom-writer: XML-escape `groupId`, `artifactId`, `version` before inserting into XML |
| P2-7 | Maven Central registry: raise `rows` limit to 500 or paginate |
| P2-8 | npm registry: add rate-limit handling (concurrency cap or retry with backoff) |
| P2-9 | `renovate-apply.js` flag parser: guard against missing value for `--include-prs`/`--exclude-prs` |
| P2-10 | Deduplicate `buildManualReview` between `mendfix.js` and `renovate-apply.js` |
| P2-11 | Automated override-remove cycle (temporary override → install → check → remove if unnecessary) |
| P2-12 | Document `x/renovate-workflow.js` or delete it |
| P2-13 | Rollback atomicity: write both snapshot files before either, or use rename-based atomic write |

**P3 — Future**

| ID | Item |
|----|------|
| P3-1 | Lock-parser: path-keyed entries to correctly handle multiple nested copies of same package |
| P3-2 | Canonical `Finding` model that separates finding data from resolution context |
| P3-3 | Full provider extensibility (Snyk, SARIF, Dependabot, OSV) via `providers/index.js` |
| P3-4 | Monorepo support for Renovate apply (multi-root `package.json`) |
| P3-5 | PR conflict detection across multiple Renovate PRs (parent+child interaction analysis) |
| P3-6 | User-configurable close-comment templates |

---

### K. Implementation Plan — P0 and P1 Items

**P0-1: confidence.js field name bug**
- Problem: `rangeViolation.parent` is undefined; `phases.js` produces `{ consumer, range }`
- Current: `src/core/confidence.js:26` `item.rangeViolation.parent`; line 67 same
- Expected: `item.rangeViolation.consumer`
- Files: `src/core/confidence.js` (2 changes: lines 26, 67)
- Approach: `s/.rangeViolation.parent/.rangeViolation.consumer/g` in that file
- Test: unit test that phase-B item with rangeViolation produces evidence string naming a
  non-undefined consumer package
- Acceptance: evidence string reads "Consumer `package-x` pins range `=6.4.2`..."
- Risk: low — pure string fix, no logic change

**P0-2: Verification failure → rollback or escalation**
- Problem: `verifyFixVersions` returns failures as warnings only; lock file may still contain
  vulnerable version after apply
- Files: `mendfix.js:634-641`, `renovate-apply.js:372-380`, `src/ecosystems/npm/installer.js`
- Approach: if `failures.length > 0`, call `restoreFiles(snapshots)` to roll back the
  package.json and lock file, log each failed package clearly, and exit with a non-zero code
  (or, alternative: mark the failed items as Phase C in the output and emit a warning).
  The rollback approach is safer and simpler.
- Test: fixture where `npm install --package-lock-only` succeeds but lock file still resolves
  the vulnerable version; verify `package.json` is reverted after run
- Acceptance: exit code non-zero; package.json unchanged from pre-apply state; output clearly
  names the unresolved package and recommends Phase C manual review
- Risk: medium — changes observable behavior; users relying on current warning-only behavior
  will see new failures; communicate clearly in changelog

**P0-3: detectManualChanges removal edge case**
- Problem: if user deletes an override key, `now === undefined`, condition `now !== lastTool`
  is false, tool silently re-applies
- File: `src/ecosystems/npm/installer.js:detectManualChanges`
- Current condition: `if (lastTool && now && now !== lastTool)`
- Fix: `if (lastTool && (now === undefined || now !== lastTool))`
- Additional: add to conflict message: "Override for X was removed by a previous edit; re-applying"
- Test: manifest shows `X: "1.2.3"`, current pkg has no `overrides.X` → should flag as conflict
- Acceptance: conflict is flagged; apply does not proceed without explicit `--force` or user ack
- Risk: low — purely additive detection

**P0-4: Maven pom-writer manifest/pom out-of-sync on error**
- Problem: `saveManifest` at `pom-writer.js:161` is called before the function can fail;
  on a subsequent exception, `restoreFiles` restores the POM but manifest is already written
- File: `src/ecosystems/maven/pom-writer.js:applyPomPatch`
- Fix: move `saveManifest` call to after all write operations succeed, still inside the try
  block, just before the `return` statement. If an exception occurs, the manifest is never
  written (the catch block restores the POM and returns without writing manifest)
- Test: inject a failure after POM write but before function return; verify manifest is absent
- Risk: low — reordering two statements within the same try block

**P0-5: renovate-workflow.js must use dep-tree**
- Problem: `runMendfixAnalyze` calls `applyPhases(plan)` without `depTree`; all dep-tree
  enrichments are disabled; Phase A items may be unsafe
- File: `renovate-workflow.js:114`
- Fix: add lock-file parsing before calling `applyPhases`:
  ```js
  const lockPath = path.join(repoDir, 'package-lock.json');
  const depTree = fs.existsSync(lockPath) ? parseLockFile(lockPath) : null;
  const phased = applyPhases(plan, depTree);
  ```
- Requires adding `require` for `lock-parser.js` at top of file
- Test: repo with a range-violation consumer; verify Phase A item is downgraded to Phase B
  when lock file is provided but remains Phase A when lock file is absent
- Acceptance: phase output from `renovate-workflow.js` matches `mendfix analyze` for same repo

**P0-6: GitHub token in git URL**
- Problem: `https://x-access-token:TOKEN@github.com/...` embeds token in process args and
  potentially in `.git/config`; git may log this
- Files: `renovate-apply.js:102-103`, `renovate-workflow.js:79`
- Fix option A (simpler): use `git -c url.https://x-access-token:TOKEN@github.com/.insteadOf=https://github.com/`
  via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env vars to avoid token in URL
- Fix option B: use `GIT_ASKPASS` helper script that echoes the token, set `GIT_USERNAME`
- Fix option C (recommended for Node): write a temporary `.git/credentials` file and call
  `git config credential.helper store --file <tmpfile>`, delete after clone
- Acceptance: git process args do not contain the token string; `.git/config` does not contain
  the token string
- Risk: medium — any approach requires testing across platforms; choose option A as simplest

**P0-7: Node 16 incompatibility**
- Problem: `fetch` is not stable until Node 18; `package.json` allows `>=16`
- Files: `package.json`, `src/providers/github.js:apiRequest`, `src/ecosystems/npm/registry.js`,
  `src/ecosystems/maven/registry.js`
- Fix: update `package.json` `engines.node` to `">=18"`. Document in CLAUDE.md and README.md.
- Alternative: add `node-fetch` v3 as a dev dependency and polyfill `globalThis.fetch` at
  CLI entry if `typeof fetch === 'undefined'`
- Recommended: raise the version floor — Node 16 is end-of-life as of September 2023
- Acceptance: running on Node 16 produces a clear "Node 18+ required" error at startup
- Risk: low — anyone using Node 16 should already be upgrading

**P1-1: Wire git-commits.js**
- File: `mendfix.js`, `src/core/git-commits.js`
- Add `--commit` flag to `mendfix apply`; after successful `verifyFixVersions`, call the
  appropriate commit function based on ecosystem and phase output
- `git-commits.js` is fully implemented; only wiring needed
- Test: run apply with `--commit` in a git repo; verify commit is created with correct message
  and only tool-generated files are staged

**P1-2: src/core/pr-description.js (Scenario 18)**
- Create new file; function signature: `generatePRDescription(phasedPlan, reportMeta) → string`
- Output file: `mend-output/pr-description.md`
- Content: CVE count table, Phase A/B/C item lists, false-positive list, recommended action
- Wire into `mendfix apply` after report generation

**P1-3: src/ecosystems/maven/dep-tree.js**
- Parse output of `mvn dependency:tree -DoutputType=text`
- Output: `DepTree` (same `Map<name, Entry[]>` shape as `lock-parser.js`)
- Called from `mendfix.js` Maven path before `applyPhases`
- Test: fixture of `mvn dependency:tree` text output → verify parent links, multiple versions

**P1-9: Minimum test suite**
- Install `jest` as devDependency
- Update `package.json` test script to `jest`
- Create `tests/` directory with at minimum:
  - `tests/core/semver-engine.test.js`: 8 scenarios (safe, exact pin, tilde, cross-major, etc.)
  - `tests/core/phases.test.js`: 6 scenarios (A, B, C, dev, multi-major)
  - `tests/core/confidence.test.js`: 2 scenarios (after P0-1 fix)
  - `tests/ecosystems/npm/lock-parser.test.js`: 5 scenarios
  - `tests/fixtures/`: minimal lockfile and package.json fixture files
- These 21 tests are the absolute minimum; 26-scenario full suite is P2

---

### L. Final V1 Checklist

```
Core engine (npm/Mend path):
[ ] P0-1: confidence.js .parent → .consumer fixed
[ ] P0-2: verification failure triggers rollback, not just warning
[ ] P0-3: manual override removal detected by detectManualChanges
[ ] P1-1: git-commits.js wired into mendfix apply --commit
[ ] P1-2: pr-description.js created and wired
[ ] Scenarios 1-17, 19-24, 26: all previously declared complete — verify with test baseline

Maven path:
[ ] P1-3: maven/dep-tree.js created
[ ] Maven applyPhases called with depTree from dep-tree.js
[ ] P0-4: pom-writer manifest written after successful POM patch
[ ] P2-1: Maven post-install version verification

Renovate workflow:
[ ] P0-5: renovate-workflow.js passes depTree to applyPhases
[ ] P1-6: buildCloseComment returns non-empty for all categories
[ ] P1-7: renovate-apply.js detects ecosystem (Maven vs npm)

Security:
[ ] P0-6: GitHub token not in git clone URL
[ ] P0-7: Node engine raised to >=18 (or fetch polyfilled and tested on 16)
[ ] P2-6: pom-writer XML-escapes all values before insertion

Architecture:
[ ] P1-4: providers/index.js wired into mendfix.js OR explicitly documented as intentional bypass
[ ] P1-5: mixed-ecosystem report rejected with clear error or routed per-entry

Testing:
[ ] P1-9: minimum test suite (21 unit tests) passing in CI
[ ] P1-10: package.json test script references file within repo
[ ] Phase 1 baseline (8 libs, 22 CVEs, A:5 B:0 C:3) reproduced by automated test

Documentation:
[ ] P1-11: repos.json missing files resolved
[ ] P1-12: CLAUDE_WORKFLOW.md updated to manual-review.md
[ ] P1-13: docs stub files deleted
[ ] x/renovate-workflow.js documented or deleted
```

---

## Implementation Steps (post-approval)

1. Write `D:\Demo\universal-dependency-engine\V1_COMPLETION_AUDIT.md` with sections A–L above
2. Do NOT modify any source files
3. Do NOT run any npm installs or scripts
4. Append session log entry to `docs/SESSION_LOG.md`

The audit document captures all findings; implementation of each fix item is a separate task.
