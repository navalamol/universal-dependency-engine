# mend-autofixer · universal-dependency-engine

Node.js CLI that reads vulnerability reports from **9 security scanners** and automatically
remediates ~90–95% of CVEs across **6 ecosystems** via deterministic SemVer resolution,
ecosystem-native patching, and CI/CD platform write-back. The remaining 5–10% land in a
structured `manual-review.md` for human triage.

**332/332 tests passing · Phases 1–5 complete**

---

## The problem

Vulnerability scanners produce dozens of CVEs across transitive dependencies. Manual triage —
read each advisory, check semver safety, write the override — takes 2–4 hours per release
cycle. Most of it is mechanical. This tool automates the mechanical loop.

**Typical result:** ~15 min of Phase A auto-apply + 30–60 min of Phase C review, down from 2–4 hours.

---

## 3-Phase confidence model

| Phase | Confidence | Criteria | Output |
|-------|-----------|----------|--------|
| **A** | 95–100% | Same-major patch/minor, dep tree verified | `phase-a-overrides.json` — auto-applied |
| **B** | 60–95% | Multiple same-major versions; forced override | `phase-b-overrides.json` — review first |
| **C** | <60% | MAJOR_BUMP / NO_FIX / multi-major conflict | `manual-review.md` — human triage required |

Hard rules — never overridden:
- `MAJOR_BUMP` → Phase C always. Never auto-applied (`nanoid 3→5` is the canonical example).
- No `@^major` selectors in overrides output — unreliable across npm versions.
- Phase C output is always `manual-review.md` — nothing is silently dropped.

---

## Supported ecosystems

| Ecosystem | Lock file | Patch file | Install verify |
|-----------|-----------|------------|----------------|
| **npm** | `package-lock.json` v2/v3 | `package.json` overrides | `npm install --package-lock-only` |
| **Maven** | `mvn dependency:tree` | `pom.xml` dependencyManagement | `mvn dependency:resolve` |
| **Python** | `poetry.lock`, `Pipfile.lock`, `requirements.txt` | `requirements.txt` / `pyproject.toml` | `pip install` in venv |
| **Go** | `go.mod` | `go.mod` replace directives | `go mod tidy` + `go mod verify` |
| **.NET / NuGet** | `packages.lock.json`, `.csproj` | `Directory.Packages.props` | `dotnet restore` |
| **Rust / Cargo** | `Cargo.lock` | `Cargo.toml` | `cargo update --precise` |

---

## Supported security providers

Auto-detected from file format — no `--provider` flag needed in most cases:

| Provider | Format |
|----------|--------|
| **Mend** | JSON + Excel |
| **Snyk** | `snyk test --json` (standard, `--all-projects`, flat array) |
| **npm audit** | `npm audit --json` v1 (npm 6) + v2 (npm 7+) |
| **Dependabot** | GitHub Security API alerts JSON |
| **OWASP Dependency-Check** | JSON schema 1.1 |
| **OSV** | osv-scanner JSON + OSV API bulk |
| **Trivy** | JSON SchemaVersion 2 (npm, Maven, Go, Python) |
| **GitLab Dependency Scanning** | `gl-dependency-scanning-report.json` v15+ |
| **JFrog Xray** | Xray JSON (npm, Maven, PyPI, Go, NuGet, Cargo) |

---

## CI/CD write-back

`mendfix apply --open-pr --platform <name>` creates a PR/MR after apply:

| Platform | Auth |
|----------|------|
| GitHub | `--github-token` or `GITHUB_TOKEN` |
| GitLab | `--gitlab-token` or `GITLAB_TOKEN`; `--gitlab-url` for self-hosted |
| Azure DevOps | `--azdo-token` or `AZURE_DEVOPS_TOKEN` |
| Bitbucket Cloud | `--bitbucket-token` or `BITBUCKET_TOKEN` |

---

## Install

```bash
npm install
```

Requires Node.js 18+ (uses native `fetch` for registry and CI/CD API calls).

---

## Usage

### Analyze — dry run, no files changed

```bash
node mendfix.js analyze --report vuln-report.json

# With registry verification
node mendfix.js analyze --report vuln-report.json --verify-versions

# With dep tree for accurate Phase B detection
node mendfix.js analyze --report vuln-report.json \
  --lock-file ../project/package-lock.json
```

### Apply — write patches and run install

```bash
# npm
node mendfix.js apply --report vuln-report.json \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json

# With auto-commit and PR creation
node mendfix.js apply --report vuln-report.json \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json \
  --commit --open-pr --platform github --github-token $GITHUB_TOKEN

# Maven
node mendfix.js apply --report vuln-report.json \
  --pom-xml ../project/pom.xml

# Python
node mendfix.js apply --report vuln-report.json \
  --requirements-txt ../project/requirements.txt

# Go
node mendfix.js apply --report vuln-report.json \
  --go-mod ../project/go.mod

# .NET
node mendfix.js apply --report vuln-report.json \
  --packages-props ../project/Directory.Packages.props

# Rust
node mendfix.js apply --report vuln-report.json \
  --cargo-toml ../project/Cargo.toml
```

### Cleanup — remove stale overrides

```bash
node mendfix.js cleanup \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json

# Simulation mode — uses actual npm install to confirm removability
node mendfix.js cleanup --simulate \
  --package-json ../project/package.json \
  --lock-file ../project/package-lock.json
```

### Portfolio — multi-repo analysis

```bash
node mendfix.js portfolio --config portfolio.json --out-dir ./portfolio-output
```

`portfolio.json` format:
```json
{
  "repos": [
    { "name": "org/repo", "report": "./vuln.json", "ecosystem": "npm", "lockFile": "./package-lock.json" }
  ],
  "outDir": "./portfolio-output",
  "verifyVersions": false
}
```

### Renovate — evaluate Renovate PRs against vulnerability findings

```bash
node mendfix.js renovate --config repos.json --apply-phase-a --close-prs
```

---

## Output files

Generated in `<report-dir>/mend-output/` (or `--out-dir`):

| File | Phase | Ecosystem |
|------|-------|-----------|
| `phase-a-overrides.json` | A | npm |
| `phase-b-overrides.json` | B | npm |
| `phase-b-parent-upgrades.json` | B (parent paths) | npm |
| `phase-a-pom-patch.xml` | A | Maven |
| `phase-b-pom-patch.xml` | B | Maven |
| `phase-a-requirements.txt` | A | Python |
| `phase-b-requirements.txt` | B | Python |
| `phase-a-go-mod.txt` | A | Go |
| `phase-b-go-mod.txt` | B | Go |
| `phase-a-packages-props.xml` | A | .NET |
| `phase-b-packages-props.xml` | B | .NET |
| `phase-a-cargo-toml.txt` | A | Rust |
| `phase-b-cargo-toml.txt` | B | Rust |
| `manual-review.md` | C | all |
| `remediation-report.md` | all | all |
| `pr-description.md` | all | all |
| `graph-diff.md` | — | npm (after apply) |
| `.mend-manifest.json` | — | all (idempotency) |

---

## Safety guarantees

- **Rollback** — snapshots manifest + lockfile before any write; restores both on install failure
- **Idempotency** — running `mendfix apply` twice produces no additional changes (`.mend-manifest.json` tracks last state)
- **Human change detection** — overrides manually edited since the last run are skipped with a warning
- **No MAJOR_BUMP auto-apply** — cross-major upgrades always land in `manual-review.md`
- **Safety Gate** — pre-apply checklist halts on MANUAL confidence, MAJOR_BUMP without parent upgrade, peer conflicts, or security regressions; bypass with `--force`

---

## Architecture

```
Provider → Core (SemVer + Phase Classifier) → Ecosystem Writer + Report
```

```
src/providers/          one file per vulnerability scanner (9 providers)
src/core/               ecosystem-agnostic engine — zero imports from providers or ecosystems
src/ecosystems/npm/     npm-specific: lock-parser, overrides, installer, simulator, registry
src/ecosystems/maven/   Maven-specific: pom-writer, dep-tree, registry, installer
src/ecosystems/python/  Python-specific: lock-parser, writer, registry, installer, simulator
src/ecosystems/go/      Go-specific: lock-parser, writer, registry, installer, simulator
src/ecosystems/dotnet/  .NET-specific: lock-parser, writer, registry, installer, simulator
src/ecosystems/rust/    Rust-specific: lock-parser, writer, registry, installer, simulator
mendfix.js              CLI — subcommands: analyze / apply / cleanup / renovate / portfolio
portfolio-runner.js     Multi-repo orchestrator
renovate-apply.js       Renovate PR evaluation workflow
```

See `CODEBASE.md` for the complete file map and exported function signatures.
See `NEXT_MISSION.md` for Phase 6 (UI layer) build plan.
See `Master_Roadmap.md` for the 9-phase product vision.

---

## Tests

```bash
npx jest --no-coverage
```

**332/332 tests passing.** Regression baseline: `mendfix analyze --report <mend-report>` → Phase A:5, B:0, C:3.
