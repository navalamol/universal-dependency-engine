# Claude Operating Manual — mend-autofixer

Read this before every session. This is the complete bootstrap.

## What this is

Node.js CLI that reads vulnerability reports and automatically remediates CVEs via npm `overrides`, Maven `pom.xml` patches, and ecosystem-specific fixes across 6 runtimes (npm, Maven, Python, Go, .NET, Rust). Phases 1–5 are complete (332/332 tests; 9 scanner providers; portfolio mode; CI/CD write-back). Phase 5.5 is the current phase: security hardening, canonical orchestration API, verified evidence model, and enterprise pilot readiness. See `NEXT_MISSION.md` for the full mission sequence.

## Architecture

```
Provider → Core (SemVer + Phase Classifier) → Ecosystem Writer + Report
```

```
src/
  providers/
    index.js            auto-detect provider from report format
    mend.js             parse Mend JSON + Excel → LibraryEntry[]
  core/                 ecosystem-agnostic — zero imports from providers/ or ecosystems/
    semver-engine.js    deterministic fix resolution → ResolutionItem[]
    phases.js           Phase A/B/C classification → PhasedItem[]
    report.js           generate markdown report (display only, no logic)
    confidence.js       evidence + alternative fields per item (Scenario 14)
    git-commits.js      auto-commit by confidence tier (Scenarios 15/16 — NOT YET WIRED)
  ecosystems/
    index.js            auto-detect npm vs maven from library types
    npm/
      lock-parser.js    package-lock.json v2/v3 → DepTree
      overrides.js      build phase-specific overrides; apply to package.json
      registry.js       npm registry version check (Node 18+ fetch)
      installer.js      npm install, rollback, lock verify, manifest
    maven/
      pom-writer.js     write + apply pom.xml dependencyManagement patches
      registry.js       Maven Central version check
mendfix.js              CLI — subcommands: analyze / apply / cleanup
mend-fix.js             backward-compat shim → requires mendfix.js
```

**Stable interfaces (never change signatures):**
- `LibraryEntry[]` — output of any provider; input to core
- `ResolutionItem[]` — output of semver-engine.js
- `PhasedItem[]` — output of phases.js; input to ecosystem writers
- `DepTree` — `Map<name, Entry[]>` output of any lock parser

Core (`src/core/`) has **zero imports** from providers or ecosystems.

## 3-Phase confidence model

| Phase | Confidence | Criteria | Output |
|-------|-----------|----------|--------|
| A | 95–100% | Same-major patch/minor, single version in tree | `phase-a-overrides.json` — auto-applied |
| B | 60–95% | Multiple same-major versions; forced override | `phase-b-overrides.json` — review first |
| C | <60% | MAJOR_BUMP; NO_FIX; multi-major version conflict | `manual-review.md` — justification required |

**Hard rules — never violate:**
- MAJOR_BUMP → Phase C always. Never auto-apply (nanoid 3→5 is the canonical example).
- Multi-major version conflict → Phase C. A single `overrides` key cannot safely cover two major lines
  without nested parent overrides. Exception: disjoint parents → nested override → Phase B.
- No `@^major` scoped selectors in any overrides output — unreliable across npm versions.
- `--package-json <path>` applies Phase A only — automatic, no extra flag.
- Phase C output is `manual-review.md` (renamed from `phase-c-review.md`).

## Test baseline — run after every logic change

```bash
node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json
```

Expected: 8 libraries, 22 CVEs. Phase A: 5, Phase B: 0, Phase C: 3. Exit 0.

```bash
# With registry verification
node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json --verify-versions
```

Report location: `D:\Automation\GH_ui-platform_dev-vulnerability-report.json`

## Rules

Don't read Plans_Prompst folder — history only.

## Key decisions

- **No AI for SemVer** — `semver` package, always deterministic.
- **package-lock.json is source of truth** — read from lock, not package.json deps.
- **Override removed after install if unnecessary** — if `npm ls pkg` resolves without it, remove it.
- **No `@^major` selectors** — unreliable; multi-major conflict → Phase C.
- **Registry check optional** — pass-through without network; exists: null = don't downgrade phase.
- **Core isolated from providers/ecosystems** — never import providers or ecosystems from src/core/.

## Session log rule

After every session that changes code, append one entry to `docs/SESSION_LOG.md`.

```
## YYYY-MM-DD — <title>
**Before:** one line on state before this session
**Changes:**
- bullet: what changed + why (why-focused)
**Next:** what's blocked or what comes after
```

## CODEBASE.md rule

After every session that adds, removes, or renames a file or exported function, update `CODEBASE.md`:
- Add new files to the File Map with one-line purpose
- Update exported function signatures that changed
- Update the Current V1 Status table
- Update "Next:" line to reflect the new next task

## Context Budget

**Soft limit: Warn at 80,000 tokens.**
**Hard limit: Warn at 120,000 tokens.**

If you estimate the conversation has consumed ~80k tokens, alert the user before continuing.

## Where to read more

| Goal | File |
|------|------|
| **File map, function signatures, data shapes (read first every session)** | `CODEBASE.md` |
| What to build next + Phase 5.5/5.6 plan | `NEXT_MISSION.md` |
| Phase C Claude triage instructions | `CLAUDE_WORKFLOW.md` |
| 9-phase product vision | `Master_Roadmap.md` |
| Feature completion tracker (all phases) | `docs/ROADMAP.md` |
| Session history + architectural decisions | `docs/SESSION_LOG.md` |
