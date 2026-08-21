# Pilot Runbook — Dependency Intelligence Engine

**Version:** Phase 5.5 / 5.6  
**Last updated:** 2026-08-21

---

## Overview

This runbook covers the end-to-end workflow for a controlled enterprise pilot:
scan → analyze → plan → apply Phase A → verify → rescan → evidence → KPI report.

A pilot run never mutates a customer's default branch automatically. All apply
operations target a dedicated branch and produce a draft PR for human review.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 18+ | Required for native `fetch` in registry checks |
| npm 9+ | Required for `overrides` field support |
| Vulnerability scanner output | Supported: Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy, GitLab, JFrog Xray |
| Repository access | Read access to scan; write access to open PRs |

---

## Step 1 — Install

```bash
# In the target repository
npm install --save-dev mend-autofixer   # or via git if not published
```

Or run from the engine root:
```bash
node /path/to/mend-autofixer/mendfix.js --help
```

---

## Step 2 — Create policy file

Add `.dependency-intelligence.yml` to the target repository root:

```yaml
version: 1
policy:
  allowedPhases:
    - A                           # auto-apply Phase A only; never B or C
  severityThreshold: HIGH         # skip LOW/MEDIUM findings
  blastRadiusLimit: 15            # block if >15 packages affected
  packageDenylist: []             # add any packages you never want auto-fixed
  freezeWindows:
    - start: '2025-12-20'
      end:   '2026-01-05'
      reason: 'Year-end deployment freeze'
verification:
  requireVerification: true       # Phase A blocked unless build+test pass
  requireRescan: false            # set to true once you have rescan set up
  build:
    - cmd: npm
      args: [run, build]
      required: true
  test:
    - cmd: npm
      args: [test]
      required: true
rescan:
  enabled: false                  # set to true if you have a scanner available
  provider: null                  # trivy | snyk | npm-audit
```

---

## Step 3 — Run analysis (dry-run)

```bash
node mendfix.js analyze \
  --report path/to/vuln-report.json \
  --lock-file package-lock.json \
  --out-dir ./dep-intel-output
```

Outputs to `dep-intel-output/`:
- `remediation-report.md` — Phase A/B/C breakdown
- `phase-a-overrides.json` — Phase A npm overrides to apply
- `manual-review.md` — Phase C items requiring human triage

Review the report before proceeding.

---

## Step 4 — Apply Phase A fixes

**Only after reviewing the analysis output.**

```bash
node mendfix.js apply \
  --report path/to/vuln-report.json \
  --lock-file package-lock.json \
  --package-json package.json \
  --out-dir ./dep-intel-output
```

This writes `npm overrides` to `package.json` and runs `npm install`.

**Safety invariants:**
- Phase B/C items are never auto-applied
- If build/test fails, the fix is rolled back
- Changes go to a dedicated branch (use `--branch dep-intel/auto-fix`)

---

## Step 5 — Verify

The engine runs verification commands configured in the policy automatically.
To run verification manually:

```bash
# Using the verifier directly
node -e "
  const { runVerification } = require('./src/core/verifier');
  runVerification([{ cmd: 'npm', args: ['test'], required: true }], process.cwd())
    .then(r => console.log(r.passed ? 'PASSED' : 'FAILED:', r.failureReason));
"
```

Verification results are recorded in the audit trail.

---

## Step 6 — Post-remediation rescan (optional)

Re-run your scanner after applying fixes, then classify the outcome:

```bash
# Run your scanner (example: npm audit)
npm audit --json > post-fix-audit.json

# Classify rescan outcomes via the adapter
node -e "
  const { classifyPlanRescanOutcomes } = require('./src/core/rescan-adapter');
  // See src/core/rescan-adapter.js for usage
"
```

---

## Step 7 — Generate KPI report

```bash
node -e "
  const { writeKPIReport } = require('./src/core/kpi-report');
  // Pass the EvidenceBundle[] collected during the run
  // writeKPIReport(bundles, './dep-intel-output', { project: 'my-repo' });
  console.log('See src/core/kpi-report.js for API');
"
```

The KPI report is written to `dep-intel-output/pilot-kpi-report.md`.

---

## Step 8 — Open draft PR

```bash
node mendfix.js apply \
  --report path/to/vuln-report.json \
  --open-pr \
  --platform github
```

Requires `GITHUB_TOKEN` environment variable.  
The PR is opened against the **dedicated branch**, never the default branch.

---

## CI/CD Integration (GitHub Actions)

Generate a reusable workflow YAML:

```js
const { generateWorkflow } = require('./src/ci/github-actions');
const yaml = generateWorkflow({
  nodeVersion:     '20',
  enableApply:     false,    // start with analyze-only
  uploadArtifacts: true,
  schedule:        '0 8 * * 1',  // Monday at 8am UTC
});
// Write yaml to .github/workflows/dependency-intelligence.yml
```

Or copy the template from `src/ci/github-actions.js`.

---

## Audit Trail

All significant events are recorded in `dep-intel-output/audit.ndjson`.
Each line is a JSON event. Events survive process restarts (append-only).

```bash
# View audit trail
cat dep-intel-output/audit.ndjson | node -e "
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', l => { const e = JSON.parse(l); console.log(e.timestamp, e.event, e.libraryName || ''); });
"
```

---

## Hygiene Analysis (D1B)

In addition to CVE fixes, run the hygiene advisor to find:
- Unused devDependencies
- Deprecated packages (registry flag)
- Preventive patch/minor upgrades
- Git/branch dependencies

```js
const { analyzeHygiene } = require('./src/core/hygiene-advisor');
const packageJson = require('./package.json');
const { findings, summary } = analyzeHygiene(packageJson, entries);
// findings[].autoApplicable is always false — all require human review
```

---

## Migration Planning (D2.1–D2.3)

For Phase C MAJOR_BUMP items, generate a migration plan:

```js
const { generateMigrationPlan, writeMigrationPlan } = require('./src/core/migration-planner');
const { scanDirectory, buildFingerprint } = require('./src/core/usage-fingerprint');

// Scan usage of the package before migrating
const scanResult = scanDirectory('./src', 'request');
const fingerprint = buildFingerprint(scanResult);

// Generate the migration plan
writeMigrationPlan(phasedPlan, './dep-intel-output', {
  fingerprints: new Map([['request', fingerprint]]),
});
// Output: dep-intel-output/major-migration-plan.md
```

---

## Pilot Guardrails

| Rule | Enforcement |
|------|-------------|
| Phase C never auto-applied | Hard-coded in phases.js — no config can override |
| MAJOR_BUMP always Phase C | Hard-coded in semver-engine.js |
| Credentials via env vars only | `--*-token` flags deprecated with warning |
| No protected-branch writes | Enforced via GitHub branch protection + dedicated branch |
| No fabricated metrics | KPI report derives all metrics from recorded evidence |
| Evidence is append-only | audit-trail.js always appends, never overwrites |

---

## Escalation

If a Phase A fix fails verification or rescan:
1. The evidence gate downgrades it to Phase B (human review)
2. The audit trail records the failure event
3. The KPI report shows `VERIFICATION_FAILED` in outcome distribution
4. No automatic retry — human approval required

For Phase C items: consult `manual-review.md` and the migration plan.

---

## Support

- Architecture: `CODEBASE.md`, `docs/SECURITY_ARCHITECTURE.md`, `docs/THREAT_MODEL.md`
- Session history: `docs/SESSION_LOG.md`
- Mission tracking: `NEXT_MISSION.md`
