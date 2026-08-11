# mend-autofixer

Node.js CLI that reads Mend (WhiteSource) security vulnerability reports and automatically
remediates ~90–95% of CVEs via npm `overrides` or Maven `pom.xml` patches. The remaining
~5–10% (major-version bumps, reachability questions, false positives) are escalated to a
structured `manual-review.md` with full context for rapid human decision-making.

## The problem

Mend scans produce dozens of CVEs across transitive dependencies. Manual triage — read each
advisory, determine fix version, check semver safety, write the override — takes 2–4 hours per
release. Most of it is mechanical.

This tool automates the mechanical loop. Typical result: **~15 min of Phase A auto-apply +
30–60 min of Phase C review**, down from 2–4 hours.

## 3-Phase confidence model

| Phase | Confidence | What it means | Output |
|-------|-----------|---------------|--------|
| **A** | 95–100% | Same-major patch/minor, dep tree verified | `phase-a-overrides.json` — auto-applied |
| **B** | 60–95% | Multiple same-major versions; forced override | `phase-b-overrides.json` — review first |
| **C** | <60% | MAJOR_BUMP / NO_FIX / multi-major conflict | `manual-review.md` — human + Claude triage |

## Supported ecosystems

- **npm** — reads `package.json` + `package-lock.json`; writes `overrides`; runs `npm install --package-lock-only`
- **Maven** — reads `pom.xml`; writes `<dependencyManagement>` patches; ecosystem auto-detected from report

## Install

```bash
npm install
```

Requires Node.js 18+ (uses native `fetch` for registry checks).

## Usage

```bash
# Analyze only — no files changed
node mendfix.js analyze --report vuln-report.json

# Analyze with npm registry version verification
node mendfix.js analyze --report vuln-report.json --verify-versions

# Analyze with dep tree for accurate Phase classification
node mendfix.js analyze --report vuln-report.json \
  --lock-file ../project/package-lock.json

# Apply Phase A fixes (npm install runs automatically)
node mendfix.js apply --report vuln-report.json \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json

# Apply Maven Phase A fixes
node mendfix.js apply --report vuln-report.json \
  --pom-xml ../project/pom.xml

# Clean up stale overrides after manual intervention
node mendfix.js cleanup \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json
```

### Flags

| Flag | Subcommands | Description |
|------|-------------|-------------|
| `--report <path>` | analyze, apply | Mend report file (`.json` or `.xlsx`) — required |
| `--lock-file <path>` | analyze, apply, cleanup | `package-lock.json` for dep tree analysis |
| `--package-json <path>` | apply, cleanup | Target `package.json`; triggers Phase A auto-apply |
| `--pom-xml <path>` | apply | Target `pom.xml` for Maven projects |
| `--verify-versions` | analyze, apply | Check npm/Maven registry before applying |
| `--out-dir <path>` | analyze | Output directory (default: next to report file) |
| `--ecosystem npm\|maven` | analyze, apply | Override ecosystem auto-detection |

Legacy flag syntax (`mend-fix.js --dry-run`, `--apply`) still works via backward-compat shim.

## Output files

Generated in `<report-dir>/mend-output/` (or `--out-dir`):

| File | Phase | Description |
|------|-------|-------------|
| `phase-a-overrides.json` | A | Ready-to-apply overrides; also applied automatically when `--package-json` is given |
| `phase-b-overrides.json` | B | Overrides needing review before apply |
| `manual-review.md` | C | Structured checklist for human + Claude triage |
| `remediation-report.md` | All | Full markdown report with CVE-level detail |

## Safety guarantees

- **Rollback** — snapshots `package.json` + `package-lock.json` before any write; restores both if `npm install` fails
- **Idempotency** — running `mendfix apply` twice produces no additional changes (`.mend-manifest.json` tracks last state)
- **Human change detection** — overrides you manually edited since the last run are skipped with a warning
- **No MAJOR_BUMP auto-apply** — cross-major upgrades always land in `manual-review.md`

## Phase C triage with Claude

When `manual-review.md` contains items, paste it alongside `package-lock.json` into a Claude
session with `CLAUDE_WORKFLOW.md` as the instruction set. Claude will trace full parent chains,
check call sites for breaking changes, write false positive justifications, and recommend
which nested overrides to add.

## Architecture

```
src/providers/    one file per vulnerability source (mend.js; future: snyk, dependabot)
src/core/         ecosystem-agnostic engine (semver, phases, report, confidence, git-commits)
src/ecosystems/   npm/ and maven/ writers; lock/dep-tree parsers
mendfix.js        CLI entry — subcommands: analyze / apply / cleanup
```

See `CLAUDE.md` for the full file map, coding standards, and development guide.
See `Master_Roadmap.md` for the 9-phase product vision.
