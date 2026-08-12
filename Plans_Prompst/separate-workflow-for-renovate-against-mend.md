# Plan: Renovate PR Workflow

## Context

Renovate Bot opens PRs for all dependency upgrades across repos — including major-version bumps with no compatibility check. Our `mendfix` tool already handles security vulnerabilities from Mend reports with a safe, phase-classified approach. The problem: teams see both Renovate PRs and mendfix recommendations, creating confusion and duplication.

This workflow bridges the two: for a list of repos, it fetches all open Renovate PRs, runs mendfix's analysis pipeline, and produces a categorized report showing which Renovate PRs are already covered (safe to close), which are insufficient or risky, and which are out of scope. Optionally closes the covered PRs with an explanatory comment.

---

## Architecture

```
repos.json config
    ↓
renovate-workflow.js (CLI)
    ↓ for each repo
    ├── git clone (or pull) → local disk
    ├── src/providers/github.js → fetch open Renovate PRs
    ├── mendfix pipeline (inline require, no spawn)
    │       └── parseReport → resolveFixVersions → classifyPhases
    ├── src/core/renovate-classifier.js → classify each PR vs mendfix results
    └── src/core/renovate-report.js → write markdown + JSON report
         ↓ if --close-prs
         src/providers/github.js → post comment + close PR
```

---

## New Files

| File | Responsibility |
|------|---------------|
| `renovate-workflow.js` | CLI entry point; orchestrates all repos sequentially |
| `src/providers/github.js` | GitHub REST API: list Renovate PRs, post comment, close PR |
| `src/core/renovate-classifier.js` | Compare each Renovate PR against mendfix PhasedItem[]; assign category |
| `src/core/renovate-report.js` | Generate markdown + JSON summary report (display only, no logic) |

No existing files are modified.

---

## CLI Interface

```bash
node renovate-workflow.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  [--clone-dir ./repos]       # default: ./repos
  [--out-dir ./renovate-output] # default: ./renovate-output
  [--close-prs]               # close COVERED_PHASE_A / COVERED_PHASE_B PRs
  [--dry-run]                 # print actions, close nothing
  [--verify-versions]         # forward to mendfix's registry check
```

### repos.json shape
```json
{
  "org": "navalamol",
  "repos": [
    { "name": "ui-platform", "report": "./input/reports/GH_ui-platform.json" },
    { "name": "ui-platform-elements", "report": "./input/reports/GH_ui-platform-elements.json" }
  ]
}
```
`org` defaults to `"navalamol"` if omitted.

---

## Per-Repo Workflow (renovate-workflow.js)

For each repo entry in `repos.json`:

1. **Clone / update** — `git clone https://github.com/{org}/{repo}.git {clone-dir}/{repo}` via `spawnSync`. If directory exists, run `git pull`.
2. **Run mendfix pipeline** — require modules directly (no child process):
   ```js
   const entries = parseReport(repoConfig.report);         // src/providers/mend.js
   const resolved = resolveFixVersions(entries);           // src/core/semver-engine.js
   const verified = await verifyVersions(resolved, ...);  // optional, src/ecosystems/npm/registry.js
   const phased = classifyPhases(verified);               // src/core/phases.js
   ```
3. **Fetch Renovate PRs** — `github.js:fetchRenovatePRs(org, repo, token)` — paginates `GET /repos/{org}/{repo}/pulls?state=open&per_page=100`, filters to PRs where `user.login` is `'renovate[bot]'` or `'renovate'`.
4. **Classify** — `renovate-classifier.js:classifyPRs(renovatePRs, phasedItems)`.
5. **Act on PRs** (if `--close-prs` and not `--dry-run`) — for each `COVERED_PHASE_A`/`COVERED_PHASE_B` PR: post comment, then close.
6. **Collect results** for the final report.

---

## Renovate PR Parsing (renovate-classifier.js)

Extract `packageName` and `proposedVersion` from the PR title using regex:
```
/(?:update\s+(?:dependency\s+)?)([\w@/.-]+)\s+to\s+v?([\d.]+(?:\.\d+)*)/i
```
Handles formats like:
- `Update dependency axios to v1.8.4`
- `chore(deps): update dependency socket.io-parser to v4.2.4`
- `Update @babel/core to v7.26.0`

---

## Classification Categories

| Category | Condition | Default action |
|----------|-----------|----------------|
| `COVERED_PHASE_A` | Package is Phase A in mendfix (same-major safe, auto-applicable) | Close PR (if `--close-prs`) |
| `COVERED_PHASE_B` | Package is Phase B (multi-version, review first) | Close PR (if `--close-prs`) |
| `DISCARDED_MAJOR_BUMP` | Package is Phase C / MAJOR_BUMP | Keep open; add context comment if `--close-prs` |
| `DISCARDED_NO_FIX` | Package is Phase C / NO_FIX | Keep open |
| `RENOVATE_INSUFFICIENT` | Package in mendfix but `proposedVersion` < required fix version (semver) | Keep open |
| `NOT_IN_MEND_REPORT` | Package not in any mendfix entry | Keep open (informational) |

Classification uses `semver.gte(proposedVersion, phasedItem.recommendedVersion)` to detect `RENOVATE_INSUFFICIENT`.

---

## Close Comment Template (github.js)

For `COVERED_PHASE_A`:
```
🔒 This upgrade is covered by mendfix Phase A (safe same-major fix).
mendfix recommends: {package}@{mendfix-version} | Renovate proposed: {package}@{renovate-version}
CVEs addressed: {cve-list}

This PR has been closed automatically. The fix is applied via package.json overrides by mendfix.
```

For `COVERED_PHASE_B`:
```
🔒 This upgrade is covered by mendfix Phase B (requires team review before applying).
...same structure...
```

For `DISCARDED_MAJOR_BUMP` (informational comment only, PR stays open):
```
⚠️ mendfix classifies this as a MAJOR_BUMP (Phase C). Renovate's proposal ({from}→{to}) requires 
manual compatibility review before merging. See manual-review.md for justification.
```

---

## Report Output (renovate-report.js)

Written to `--out-dir/`:

**`renovate-workflow-report.md`** — one section per repo:
```markdown
# Renovate PR Workflow Report — {date}
## Summary Table
| Repo | Total PRs | Phase A | Phase B | Major Bump | Insufficient | Out of Scope |

## {repo-name}
### ✅ Covered by mendfix Phase A (safe to close)
| PR # | Title | Package | Renovate v | mendfix v | CVEs |

### ⚠️ Covered by mendfix Phase B (review then close)
...

### 🚫 Discarded — Major bump (keep open)
...

### ⚠️ Renovate insufficient (keep open, version too low for CVE fix)
...

### ℹ️ Not in Mend report (out of scope)
...
```

**`renovate-workflow-report.json`** — machine-readable version with the same structure for downstream processing.

---

## Reused Existing Modules

| Module | Reused from |
|--------|-------------|
| `src/providers/mend.js` → `parseReport` | Unchanged |
| `src/core/semver-engine.js` → `resolveFixVersions` | Unchanged |
| `src/core/phases.js` → `classifyPhases` | Unchanged |
| `src/ecosystems/npm/registry.js` → `verifyNpmVersions` | Unchanged, optional |

---

## Verification

```bash
# 1. Smoke test (dry-run, no token needed for cloning public repos)
node renovate-workflow.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  --dry-run

# 2. Full run without closing PRs
node renovate-workflow.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN

# 3. Full run with PR closing
node renovate-workflow.js \
  --config repos.json \
  --github-token $GITHUB_TOKEN \
  --close-prs

# Expected output:
# - renovate-output/renovate-workflow-report.md
# - renovate-output/renovate-workflow-report.json
# - Console: per-repo progress + category counts
# - Closed PRs (if --close-prs): each with a category-specific comment
```
