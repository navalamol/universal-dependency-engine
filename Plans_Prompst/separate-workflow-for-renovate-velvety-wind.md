# Plan: Renovate Apply Workflow (renovate-apply.js)

## Context

`renovate-workflow.js` (Phase 1) compared Renovate PRs against Mend vulnerability reports and categorised them. The new insight: Mend is secondary. The real goal is to evaluate whether each Renovate-proposed upgrade is **safe to apply** — using the same semver + phase engine — and then actually apply the safe ones to `package.json`, run `npm install --package-lock-only`, and write a report.

**Simplified end-state:**  
10 Renovate PRs → analyze all → apply all Phase A safe fixes under one batch (direct bumps + overrides) → report which are Phase B/C (risky, manual needed) → optionally close all Renovate PRs.

The existing `renovate-workflow.js` (Mend-comparison tool) is preserved and unchanged.

---

## Architecture

```
repos.json (org + repo names, no Mend report field)
    ↓
renovate-apply.js (new CLI)
    ↓ per repo
    ├── git clone/pull → repos/{repo}/
    ├── github.js: fetchRenovatePRs() → open Renovate PRs
    ├── parsePRTitle() → { packageName, proposedVersion }[]
    ├── read repos/{repo}/package.json → current versions of direct deps
    ├── read repos/{repo}/package-lock.json → depTree + current versions of transitives
    ├── renovate-builder.js: buildResolutionItems() → ResolutionItem[]
    ├── phases.js: applyPhases(items, depTree) → PhasedItem[]
    ├── [optional] registry.js: verifyPlanVersions()
    ├── writeOutputRenovate() → phase-a-overrides.json, manual-review.md, renovate-report.md
    │   (reuses: detectDirectDeps, applyDirectUpgrades, buildPhaseAOverrides, applyOverridesToPackageJson)
    │   [if --apply]: runPackageLockUpdate + verifyFixVersions + saveManifest
    └── [if --close-prs]: postComment + closePR for Phase A/B PRs
```

---

## New Files

| File | Responsibility |
|------|---------------|
| `renovate-apply.js` | New CLI. Orchestrates all repos. Accepts `--config`, `--github-token`, `--apply`, `--close-prs`, `--dry-run`, `--verify-versions`, `--clone-dir`, `--out-dir` |
| `src/core/renovate-builder.js` | Builds `ResolutionItem[]` from Renovate PR upgrade data + package.json/lockfile. No Mend report needed. |

`renovate-report.js` (existing) is updated to handle Renovate-sourced items (no CVE data; shows PR numbers instead of CVE IDs).

---

## `repos.json` — simplified schema (no `report` field)

```json
{
  "org": "riversandtechnologies",
  "repos": [
    { "name": "ui-platform" },
    { "name": "ui-platform-elements" }
  ]
}
```

---

## CLI Interface

```bash
node renovate-apply.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  [--clone-dir ./repos]          # default: ./repos
  [--apply]                      # write package.json + run npm install --package-lock-only
  [--verify-versions]            # check npm registry for each proposed version
  [--close-prs]                  # close Phase A PRs with comment after applying
  [--dry-run]                    # print plan, no changes, no closes
  [--out-dir <base-path>]        # override output base; default: inside clone dir
```

---

## `src/core/renovate-builder.js` — key logic

**`buildResolutionItems(prUpgrades, pkg, lockEntries)`**

`prUpgrades` = `[{ prNumber, prTitle, packageName, proposedVersion }]` (from `parsePRTitle`)

For each upgrade:
1. Resolve `currentVersion` via `getCurrentVersion(packageName, pkg, lockEntries)`:
   - Check `pkg.dependencies`/`pkg.devDependencies` first (strip range prefix via `semver.coerce`)
   - Fall back to lock file resolved version (lowest installed version — most likely the vulnerable one)
   - If not found anywhere → skip with `NOT_FOUND_IN_REPO` marker
2. Compute `upgradeType`:
   - `semver.major(proposedVersion) > semver.major(currentVersion)` → `MAJOR_BUMP`
   - Otherwise → `SAFE`
3. Return a `ResolutionItem` shaped exactly like `buildResolutionPlan` output, with `cves: []`, plus Renovate extras (`prNumber`, `prTitle`) for the report.

**Key detail:** `NO_FIX` won't arise (Renovate always proposes a version). Multi-version / multi-major conflicts are detected by `applyPhases` when multiple ResolutionItems share the same `libraryName` (one item per Renovate PR, and the same package can have multiple versions in the lock file through different chains). This is identical to how the Mend flow works.

---

## `writeOutputRenovate` function (in `renovate-apply.js`)

Reuses these existing functions exactly — no modifications needed:

| Existing function | From | Used for |
|---|---|---|
| `detectDirectDeps(phaseA, pkg, depTree)` | `src/ecosystems/npm/overrides.js` | Split direct bumps from overrides |
| `applyDirectUpgrades(pkg, directUpgrades)` | `src/ecosystems/npm/overrides.js` | Bump version in dependencies/devDependencies |
| `buildPhaseAOverrides(phasedPlan)` | `src/ecosystems/npm/overrides.js` | Build flat overrides map |
| `buildPhaseBOverrides(phasedPlan)` | `src/ecosystems/npm/overrides.js` | Build Phase B overrides map |
| `applyOverridesToPackageJson(path, overrides)` | `src/ecosystems/npm/overrides.js` | Merge overrides into package.json |
| `runPackageLockUpdate(dir)` | `src/ecosystems/npm/installer.js` | npm install --package-lock-only |
| `verifyFixVersions(lockPath, items)` | `src/ecosystems/npm/installer.js` | Post-install version check |
| `saveManifest(path, overrides, directUpgrades)` | `src/ecosystems/npm/installer.js` | Write .mend-manifest.json |
| `snapshotFiles / restoreFiles` | `src/ecosystems/npm/installer.js` | Rollback on failure |
| `parseLockFile` | `src/ecosystems/npm/lock-parser.js` | Build dep tree from lock |
| `parsePRTitle` | `src/core/renovate-classifier.js` | Extract packageName + proposedVersion |
| `fetchRenovatePRs / postComment / closePR` | `src/providers/github.js` | GitHub API |

**Flow of `writeOutputRenovate`** (mirrors `writeOutputNpm` from `mendfix.js`):
1. Split Phase A → `directUpgrades` + `overrideItems` via `detectDirectDeps`
2. Build override maps via `buildPhaseAOverrides` / `buildPhaseBOverrides`
3. Write `phase-a-overrides.json`, `phase-b-overrides.json` (if non-empty), `manual-review.md` (if Phase C), `renovate-report.md`
4. If `--apply`: snapshot → apply direct bumps → merge overrides → write package.json → `runPackageLockUpdate` → verify → `saveManifest`; rollback on failure

---

## Output Location

Default: `{cloneDir}/{repoName}/output-renovate-{repoName}/`  
With `--out-dir <base>`: `{base}/{repoName}/`

Contents:
```
output-renovate-ui-platform/
  phase-a-overrides.json       always written
  phase-b-overrides.json       if Phase B items exist
  manual-review.md             if Phase C items exist
  renovate-report.md           always written
```

When `--apply` is set: `repos/ui-platform/package.json` and `package-lock.json` are modified in place (the cloned copy).

---

## `renovate-report.md` — Renovate-specific format

No CVE IDs. PR numbers/titles replace CVE data.

```markdown
# Renovate Upgrade Analysis — ui-platform — 2026-08-11

## Summary
| Category | Count | PR Numbers |
|Phase A — safe to apply | 4 | #101 #105 #108 #110 |
|Phase B — review first  | 1 | #103 |
|Phase C — Major bump    | 2 | #102 #106 |
|Phase C — Multi-major   | 1 | #107 |
|Not found in repo       | 2 | #104 #109 |

## Phase A — Applied (or ready to apply)
| PR | Package | Current | Renovate → | Type | Status |
| #101 | axios | 1.16.0 | 1.18.0 | direct dep | applied |
| #105 | postcss | 8.4.31 | 8.5.23 | override | applied |

## Phase B — Requires Review Before Applying
...

## Phase C — Risky (not applied)
...

## Not Found in This Repo
...
```

---

## PR Close Comment (Phase A)

```
This upgrade was analyzed and applied by the mendfix Renovate workflow.

Package: {pkg} {currentVersion} -> {proposedVersion}
Type: Phase A (safe same-major upgrade)
Applied: {directUpgrade or override}
```

---

## Categories

| Category | Condition | Applied? | PR action |
|---|---|---|---|
| `PHASE_A_SAFE` | Same-major, single version or all consumer ranges OK | Yes (with --apply) | Close (with --close-prs) |
| `PHASE_B_REVIEW` | Multi-version same major or consumer range violation | No | Leave open |
| `PHASE_C_MAJOR_BUMP` | Cross-major upgrade | No | Leave open (optional comment) |
| `PHASE_C_MULTI_MAJOR` | Multiple major lines in tree | No | Leave open |
| `NOT_FOUND_IN_REPO` | Package not in package.json or lock file | No | Leave open |

---

## Reused Existing Modules (unchanged)

- `src/core/phases.js` → `applyPhases` — unchanged
- `src/ecosystems/npm/overrides.js` → `detectDirectDeps`, `applyDirectUpgrades`, `buildPhaseAOverrides`, `buildPhaseBOverrides`, `applyOverridesToPackageJson` — unchanged
- `src/ecosystems/npm/installer.js` → `runPackageLockUpdate`, `verifyFixVersions`, `saveManifest`, `snapshotFiles`, `restoreFiles` — unchanged
- `src/ecosystems/npm/lock-parser.js` → `parseLockFile` — unchanged
- `src/ecosystems/npm/registry.js` → `verifyPlanVersions` — unchanged
- `src/providers/github.js` → `fetchRenovatePRs`, `postComment`, `closePR` — unchanged
- `src/core/renovate-classifier.js` → `parsePRTitle` — unchanged (other exports unused)

---

## Future: Git Workflow (out of scope for this session)

After `--apply` writes changes to the cloned repo:
1. `git checkout -b renovate-mendfix-batch-{date}` in the clone
2. `git add package.json package-lock.json`
3. `git commit -m "chore: apply safe Renovate upgrades (Phase A) via mendfix"`
4. `git push -u origin {branch}`
5. `gh pr create --title "chore: batch safe Renovate upgrades" --body {report link}`
6. Close all Renovate PRs (Phase A + others with --close-all flag)

This consolidates N Renovate PRs → 1 PR per repo.

---

## Verification

```bash
# 1. Dry run — no files changed
node renovate-apply.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  --dry-run

# 2. Generate report only (no apply)
node renovate-apply.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN

# 3. Full apply — modifies cloned repo's package.json + runs npm install
node renovate-apply.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  --apply \
  --verify-versions

# 4. Full apply + close Phase A PRs
node renovate-apply.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  --apply \
  --close-prs

# Expected per repo:
# - repos/ui-platform/output-renovate-ui-platform/renovate-report.md
# - repos/ui-platform/output-renovate-ui-platform/phase-a-overrides.json
# - repos/ui-platform/package.json (modified if --apply)
# - repos/ui-platform/package-lock.json (modified if --apply + npm succeeded)
```
