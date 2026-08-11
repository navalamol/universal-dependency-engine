# Claude Operating Manual — mend-autofixer

Read this before every session. This is the complete bootstrap.

## What this is

Node.js CLI that reads Mend vulnerability reports and automatically remediates ~90–95% of CVEs via
npm `overrides` or Maven `pom.xml` patches. The remaining ~5–10% (Phase C) is handled by Claude
via `CLAUDE_WORKFLOW.md`. Phase 1 (Mend/npm/Maven) is at ~97%. See `NEXT_MISSION.md` for remaining
gaps and Phase 2 entry criteria.

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

Core (`src/core/`) has **zero imports** from providers or ecosystems. This is what keeps Phases 2–9
cheap to add: drop a new provider file, register it in index.js — core is untouched.

## Coding standards

- Plain Node.js CommonJS `require`. No TypeScript. No build step.
- Deps: `semver`, `xlsx` only.
- One file, one responsibility. No mixing parsing with output.
- Comments only for non-obvious "why," never "what."
- No error handling in internal paths; validate only at CLI boundaries.

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

## Phase 1 completion status

**Done (all verified against test baseline):**
- Scenarios 1, 11: Parse Mend JSON + Excel; highest-safe-version selection
- Scenario 2: package-lock.json dep tree (parents, ranges, dev flag)
- Scenarios 3, 10: SemVer compatibility check; multiple dep chain analysis
- Scenario 4: parent upgrade recommendations surfaced in Phase C output
- Scenario 5: npm install + lock verification after apply
- Scenarios 6, 7: stale override detection and cleanup (mendfix cleanup)
- Scenario 8: dev classification (all-dev → probableFalsePositive); mixed chains deferred
- Scenario 9: false positive flag + justification template via CLAUDE_WORKFLOW.md
- Scenarios 12, 13: direct dep vs override detection; priority order enforced
- Scenario 14: confidence.js — evidence + alternative fields (wired into enrichWithConfidence)
- Scenario 17: markdown remediation report
- Scenarios 19, 20: mendfix analyze / apply subcommands
- Scenario 21: idempotency pre-flight (compares against .mend-manifest.json)
- Scenario 22: rollback on npm install failure
- Scenario 23: WHY-focused logging on every decision
- Scenario 24: manual-review.md output
- Scenario 26: human change detection via .mend-manifest.json

**Remaining gaps (Phase 1 not yet complete):**
- Scenarios 15/16: git-commits.js written but NOT called from mendfix.js apply — needs wiring
- Scenario 18: PR description generation — `pr-description.md` not yet built
- Scenario 25: Final PR-ready state blocked by 15/16 + 18
- Maven dep-tree parser (`src/ecosystems/maven/dep-tree.js`) — unlocks Phase B for Java
- Scenario 8 full: deep mixed dev/runtime chain classification

## Test baseline — run after every logic change

```bash
node mendfix.js analyze --report GH_ui-platform_dev-vulnerability-report.json
```

Report location: `D:\Automation\GH_ui-platform_dev-vulnerability-report.json` (one level up from project root)

Expected: 8 libraries, 22 CVEs. Phase A: 5 (fast-uri, socket.io-parser, postcss, unzipper, axios).
Phase B: 0. Phase C: 3 (nanoid [MAJOR_BUMP], brace-expansion ×2 [multi-major conflict]). Exit 0.

```bash
# With registry verification
node mendfix.js analyze --report ../GH_ui-platform_dev-vulnerability-report.json --verify-versions

# Full apply (needs a real project's package.json)
node mendfix.js apply --report ../GH_ui-platform_dev-vulnerability-report.json \
  --package-json /path/to/package.json --verify-versions

# Post-install cleanup
node mendfix.js cleanup --package-json /path/to/package.json \
  --lock-file /path/to/package-lock.json
```

## Never break existing functionality

- `resolveFixVersion`: same-major safe, cross-major bump, no-fix, multi-CVE grouping. Do not simplify.
- Phase A overrides: clean `"pkg": "version"` — no selectors, no ranges.
- `applyOverridesToPackageJson`: merges, never replaces, existing overrides.
- Registry check: always optional; script works without network; phase not downgraded if unreachable.
- `mend-fix.js` shim: must stay for backward compat.

## Script vs Claude division

**Script owns (deterministic):** parse → SemVer → dep graph → overrides → npm install → verify lock → remove overrides → commits → report

**Claude owns (uncertain 5–10%, via `CLAUDE_WORKFLOW.md`):** Phase C justification review · false positive chain analysis · MAJOR_BUMP API compatibility judgement


## Rules

Don't read Plans_Prompst folder it is for just maintaining history

# Context Budget


**Soft limit: Warn at 80,000 tokens.**
**Hard limit: Warn at 120,000 tokens.**

If you estimate the conversation has consumed ~80k tokens, stop and alert the user before continuing:
> ⚠ Context is approaching 80k tokens. To avoid autocompact (which caused context loss at ~200k in Mission 8–9), consider starting a fresh conversation and loading only the required context for the next task.

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

Skip: debugging steps, things obvious from reading the code. Include: architectural decisions,
reversed decisions, non-obvious constraints, user feedback that shaped direction.

## Where to read more

| Goal | File |
|------|------|
| What to build next (priorities, Phase 2 entry) | `NEXT_MISSION.md` |
| Phase C Claude triage instructions | `CLAUDE_WORKFLOW.md` |
| 9-phase product vision | `Master_Roadmap.md` |
| All 26 Phase 1 scenarios with completion status | `docs/Phase_1_Goal.md` |
| Feature completion tracker | `docs/ROADMAP.md` |
| Session history + architectural decisions | `docs/SESSION_LOG.md` |
