# Mend AutoFixer

## What is Mend AutoFixer?

A Node.js CLI that reads Mend (WhiteSource) security vulnerability reports and automatically
generates the minimal npm `overrides` needed to resolve them — with zero manual triage for
the majority of findings.

## What problem does it solve?

Mend scans produce vulnerability reports listing dozens of CVEs across transitive dependencies.
Resolving them manually — reading each advisory, determining the right fix version, deciding
whether a semver bump is safe, and writing the override — is slow and error-prone.

This tool automates that entire triage loop: **~90-95% of CVEs are resolved automatically**.
The remaining ~5-10% (major-version bumps, reachability questions, false positives) are flagged
for human review with enough context to act quickly.

## Features

- Parses Mend JSON and Excel (`.xlsx`) report formats
- Groups multiple CVEs per library and determines the single minimum fix version
- Prefers same-major upgrades (SAFE) — no unnecessary breaking changes
- Detects when multiple major versions of the same package are vulnerable and emits
  scoped overrides (e.g. `"brace-expansion@^1"`, `"brace-expansion@^2"`)
- Falls back to cross-major recommendation (MAJOR_BUMP) when no same-major fix exists
- Writes a ready-to-paste `overrides-patch.json`
- Generates a full markdown remediation report with CVE-level detail
- Optional `--apply` flag merges overrides directly into your `package.json`

## Workflow

```
Mend Report (JSON/Excel)
        │
        ▼
   Parse report
        │
        ▼
 Group by library  ←── library.keyUuid deduplicates multiple CVEs per package
        │
        ▼
 SemVer Engine    ←── prefer same-major fix; fallback to cross-major
        │
        ├── SAFE       → overrides (automated)
        ├── MAJOR_BUMP → overrides + review flag
        └── NO_FIX     → reachability / false positive assessment (manual)
        │
        ▼
 Write overrides-patch.json + remediation-report.md
```

## Architecture

```
mend-fix.js            CLI entry point — orchestrates all steps
src/parser.js          Parse JSON and Excel reports → normalized LibraryEntry[]
src/semver-engine.js   Determine minimum fix version per library (deterministic SemVer)
src/overrides.js       Build npm overrides map; handle multi-version scoping
src/report.js          Generate markdown remediation report
```

## Folder structure

```
mend-autofixer/
  mend-fix.js                        CLI entry point
  package.json
  src/
    parser.js
    semver-engine.js
    overrides.js
    report.js
  docs/
    01_PRODUCT.md … 07_FUTURE.md     Design docs and decisions
  mend-output/                       Generated on each run (gitignored)
    overrides-patch.json
    remediation-report.md
```

## How to run

```bash
# Install dependencies (one-time)
npm install

# Dry run — print plan without writing files
node mend-fix.js --report vuln-report.json --dry-run

# Generate overrides-patch.json + remediation-report.md in ./mend-output/
node mend-fix.js --report vuln-report.json

# Generate AND apply overrides directly into a package.json
node mend-fix.js --report vuln-report.json \
  --apply \
  --package-json ../ui-platform/package.json

# Then in the target project:
npm install
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--report <path>` | Mend report file (`.json` or `.xlsx`) | required |
| `--package-json <path>` | Target `package.json` for `--apply` | `./package.json` |
| `--out-dir <path>` | Output directory | `./mend-output` |
| `--apply` | Merge overrides directly into `package.json` | off |
| `--dry-run` | Print plan to stdout, write nothing | off |

## Future roadmap

Parse `package-lock.json` to build the full dependency graph, enabling accurate parent-package
upgrade paths, reachability analysis (is the vulnerable code path actually exercised?), and
automatic false-positive classification — moving the automation coverage closer to 100%.
