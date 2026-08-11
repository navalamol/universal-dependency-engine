# Phase 1 Goal — 26 Scenarios

Goal: replicate the current manual Mend remediation process with minimal manual work.
If the tool cannot do what was done manually, Phase 1 is incomplete.

## Completion status

| Scenario | Description | Status |
|----------|-------------|--------|
| 1 | Read Mend Excel/JSON | ✅ Done |
| 2 | Package-lock analysis (dep chain, parents, installed version) | ✅ Done |
| 3 | SemVer compatibility (^/~/exact range check) | ✅ Done |
| 4 | Parent upgrade check before overriding | ✅ Done (rootParents surfaced in Phase C) |
| 5 | Temporary override + npm install + verify lock | ✅ Done |
| 6 | Override cleanup after install resolves naturally | ✅ Done (mendfix cleanup) |
| 7 | Unnecessary override detection and removal | ✅ Done (mendfix cleanup) |
| 8 | Runtime vs build classification | ⚡ Partial (all-dev → false positive; mixed chains deferred) |
| 9 | False positive justification generation | ⚡ Partial (flag set; justification template in CLAUDE_WORKFLOW.md) |
| 10 | Multiple dependency chains for same package | ✅ Done |
| 11 | Highest safe version (not highest overall) | ✅ Done |
| 12 | Direct dependency → direct upgrade (not override) | ✅ Done |
| 13 | Priority order: direct upgrade > parent upgrade > override | ✅ Done |
| 14 | Confidence + reason + evidence + alternative per recommendation | ✅ Done (confidence.js) |
| 15 | High-confidence auto-commit (Phase A) | ⚡ Partial (git-commits.js written; not wired) |
| 16 | Medium-confidence separate commit (Phase B/C) | ⚡ Partial (same file; not wired) |
| 17 | Markdown report with all fields | ✅ Done |
| 18 | PR description auto-generated | ❌ Not started |
| 19 | `mendfix analyze` dry-run subcommand | ✅ Done |
| 20 | `mendfix apply` subcommand | ✅ Done |
| 21 | Idempotency (apply twice = no change) | ✅ Done |
| 22 | Rollback on install failure | ✅ Done |
| 23 | Every decision explains WHY | ✅ Done |
| 24 | Below-threshold items → manual-review.md | ✅ Done |
| 25 | Final PR-ready state | ⚡ Blocked by 15/16 + 18 |
| 26 | Preserve human changes (detect + skip manually-edited overrides) | ✅ Done |

**Phase 1 completion: 20/26 done, 4 partial, 1 not started, 1 blocked**

---

## Scenario definitions

### Scenario 1 — Read Mend Excel/JSON
Input: Mend Excel or JSON report. Extract: Package, Version, Severity, CVE, CVSS,
Recommendation, Fixed Version(s), Advisory URL, Description. No manual parsing.

### Scenario 2 — Package Lock Analysis
Given `package-lock.json`, determine: installed version, every occurrence, parent packages,
full dependency chain. Example: `root → webpack → ajv → fast-uri`. No manual searching.

### Scenario 3 — SemVer Compatibility
`^6.4.2` with recommended `6.5.7` → SAFE. Exact `6.4.2` with `6.5.7` → Requires Review.
Exactly how the manual process worked.

### Scenario 4 — Parent Upgrade
Before overriding, check if the parent can be upgraded to a version that ships the fixed child.
If yes, prefer parent upgrade over override.

### Scenario 5 — Temporary Override
When safe: add override → run `npm install --package-lock-only --legacy-peer-deps` → verify package updated.

### Scenario 6 — Override Cleanup
After install, if the package naturally resolves to the required version, the override is removed automatically.

### Scenario 7 — Unnecessary Overrides
Detect existing overrides that are no longer needed → automatically remove.

### Scenario 8 — Runtime vs Build
Classify Runtime / Build / Test / Development using dependency ancestry. Not guesses.

### Scenario 9 — False Positive
When: no fix available + build only + not shipped → generate False Positive Justification automatically.

### Scenario 10 — Multiple Dependency Chains
Package appears via `webpack → fast-uri` AND `eslint → fast-uri`. Tool analyzes BOTH chains.

### Scenario 11 — Highest Safe Version
Mend recommends 3.1.4, 4.1.1, 2.4.3. Tool should choose highest *compatible* version — not highest overall.

### Scenario 12 — Direct Dependency
Package exists in `package.json` → recommend direct version bump instead of override.

### Scenario 13 — Override vs Parent Upgrade Priority
Priority: Direct upgrade > Parent upgrade > Override. Never reverse.

### Scenario 14 — Confidence
Every recommendation must include: Confidence, Reason, Evidence, Alternative.

### Scenario 15 — High Confidence Commit
Automatically generate commit for high-confidence (Phase A) fixes only. Safe updates only.

### Scenario 16 — Medium Confidence Commit
Separate commit for riskier (Phase B/C) overrides. Exact versions. Potentially breaking.

### Scenario 17 — Markdown Report
Should include: Package, Current, Recommended, Reason, Confidence, Action, Parent, Runtime, Commit.

### Scenario 18 — PR Description
Automatically generated PR body: packages fixed, CVEs closed, confidence breakdown, manual items.

### Scenario 19 — Dry Run
Support `mendfix analyze`. No files changed. Only report.

### Scenario 20 — Apply
Support `mendfix apply`. Actually modify the repository.

### Scenario 21 — Idempotency
Running `mendfix apply` twice should produce no additional changes.

### Scenario 22 — Rollback
If install fails, restore original `package.json` and `package-lock.json`.

### Scenario 23 — Logging
Every decision should explain WHY. Never just "Updated."

### Scenario 24 — Manual Review
Anything below confidence threshold must move into `manual-review.md`. Never silently apply.

### Scenario 25 — Final PR Ready
End result: `package.json`, `package-lock.json`, reports, commits, PR description,
false positive report. Ready to push.

### Scenario 26 — Preserve Human Changes
If overrides were manually edited since last run: detect the changes, avoid overwriting them
blindly, clearly report conflicts. Prevents automation from undoing intentional engineering decisions.
