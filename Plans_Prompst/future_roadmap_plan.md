# Plan: Folder Structure, Architecture & Roadmap Alignment

## Context

Phase 1 is ~95% complete (all 26 scenarios, with 6 remaining: 14, 15/16, 18, 19/20, 21, 24). Master_Roadmap.md shows 9 phases. The current flat `src/` works for Phase 1 (one provider, two ecosystems) but will not scale to Phase 2 (multi-provider: Mend + Snyk + Dependabot + npm audit) or Phase 3 (multi-ecosystem: npm + Maven + Python + .NET + Go + Rust).

The goal is to restructure NOW — via file moves and path updates, no logic rewrites — so that Phase 2 additions are `src/providers/snyk.js` and `src/ecosystems/pip/`, not wholesale refactors.

---

## Proposed Folder Structure

```
mend-autofixer/
├── mendfix.js                        ← rename from mend-fix.js; add analyze/apply subcommands
├── CLAUDE.md                         ← update paths
├── CLAUDE_WORKFLOW.md
├── Master_Roadmap.md
├── package.json
│
├── src/
│   ├── core/                         ← ecosystem-agnostic, stable across all phases
│   │   ├── semver-engine.js          ← moved (no logic change)
│   │   ├── phases.js                 ← moved
│   │   ├── report.js                 ← moved
│   │   └── confidence.js             ← NEW: Scenario 14 — evidence + alternative fields
│   │
│   ├── providers/                    ← one file per vulnerability report source
│   │   ├── index.js                  ← NEW: auto-detect provider from report format
│   │   └── mend.js                   ← moved from parser.js (no logic change)
│   │   (future: snyk.js, dependabot.js, npm-audit.js)
│   │
│   └── ecosystems/
│       ├── index.js                  ← NEW: auto-detect ecosystem from library type
│       ├── npm/
│       │   ├── lock-parser.js        ← moved
│       │   ├── overrides.js          ← moved
│       │   ├── registry.js           ← moved from npm-registry.js
│       │   └── installer.js          ← moved from install-runner.js
│       └── maven/
│           ├── pom-writer.js         ← moved
│           └── registry.js           ← moved from maven-registry.js
│           (future: dep-tree.js)
│
└── docs/
    ├── SESSION_LOG.md
    ├── ROADMAP.md
    └── (existing docs 01–07, decisions)
    (move Phase_1_Goal.md, Phase_2_Path.md, Manual_Automation_Next_Phase.md here too)
```

**What does NOT change:** All logic, all function signatures, all exports. This is path rewiring only. The key interfaces are already stable:
- `LibraryEntry[]` — output of any provider parser, input to core
- `ResolutionItem[]` — output of semver-engine
- `PhasedItem[]` — output of phases.js, input to any ecosystem writer
- `DepTree` — output of any ecosystem lock parser

---

## Migration Steps (file moves only)

| From | To |
|------|----|
| `src/parser.js` | `src/providers/mend.js` |
| `src/semver-engine.js` | `src/core/semver-engine.js` |
| `src/phases.js` | `src/core/phases.js` |
| `src/report.js` | `src/core/report.js` |
| `src/npm-registry.js` | `src/ecosystems/npm/registry.js` |
| `src/overrides.js` | `src/ecosystems/npm/overrides.js` |
| `src/lock-parser.js` | `src/ecosystems/npm/lock-parser.js` |
| `src/install-runner.js` | `src/ecosystems/npm/installer.js` |
| `src/maven-registry.js` | `src/ecosystems/maven/registry.js` |
| `src/pom-writer.js` | `src/ecosystems/maven/pom-writer.js` |
| `mend-fix.js` | `mendfix.js` |
| `Phase_1_Goal.md` | `docs/Phase_1_Goal.md` |
| `Phase_2_Path.md` | `docs/Phase_2_Path.md` |
| `Manual_Automation_Next_Phase.md` | `docs/Manual_Automation_Next_Phase.md` |

All `require()` paths in `mendfix.js` updated to new locations. No other files need changes.

---

## New Files to Add (Phase 1 completion)

### `src/providers/index.js`
Detects provider from report format. Logic: if `vulnerabilities[]` with `library.type` → mend. Returns the right parser module. Keeps `mendfix.js` clean.

```js
function detectProvider(filePath) { /* ext + content sniff */ }
function getParser(provider) { return require(`./${provider}`); }
```

### `src/ecosystems/index.js`
Detects ecosystem from parsed entries. Logic: if any `libraryType === 'MAVEN_ARTIFACT'` → maven; else → npm. Can be overridden by `--ecosystem` flag.

### `src/core/confidence.js` — Scenario 14
Adds `evidence` and `alternative` fields to each resolution item. `evidence` = the lock-file facts (consumer ranges, dep chain) that justify the phase. `alternative` = what to do instead if the recommendation fails (e.g., "upgrade parent webpack to 5.x").

### `mendfix.js` — Scenarios 19/20
Replace flag-based mode switching with subcommands:
```
mendfix analyze  [--report <f>] [--lock-file <f>] [--verify-versions] [--out-dir <d>]
mendfix apply    [--report <f>] [--package-json <f>] [--pom-xml <f>] [--lock-file <f>] [--verify-versions]
mendfix cleanup  [--package-json <f>] [--lock-file <f>]
```
Keep `mend-fix.js` as a thin shim (`require('./mendfix')`) for backward compat during transition.

### `src/core/git-commits.js` — Scenarios 15/16
Three commit functions:
- `commitPhaseA(outputDir)` — auto-commit high-confidence fixes, message format defined
- `commitPhaseBС(outputDir)` — separate commit for reviewed fixes
- `commitFalsePositives(outputDir)` — docs-only commit for false positive justifications

### Phase C output — Scenario 24
Rename `phase-c-review.md` → `manual-review.md` in output. Already generated; just change the filename and update CLAUDE_WORKFLOW.md references.

### Idempotency — Scenario 21
Already ~90% covered by `.mend-manifest.json`. Gap: if `mendfix apply` is run twice, the second run must produce zero changes AND exit 0 with "nothing to apply" message. Add a pre-flight check in the apply path that compares current state against manifest before doing any work.

---

## Architecture Principles (unchanged, now explicit)

1. **Provider interface**: `parse(filePath) → LibraryEntry[]` — any file in `src/providers/` exports this.
2. **Ecosystem writer interface**: `write(phasedPlan, options) → {written, skipped}` — any ecosystem module exports this.
3. **Core is provider/ecosystem-agnostic** — `src/core/` has zero imports from `providers/` or `ecosystems/`.
4. **No AI in core** — semver-engine.js stays deterministic; Claude is invoked only via CLAUDE_WORKFLOW.md.
5. **Plain CommonJS** — no TypeScript, no build step, no DI.

---

## Roadmap Alignment

| Phase | Status | Folder change required |
|-------|--------|------------------------|
| 1 — Mend/npm/Maven | ~95% done | This restructure |
| 2 — Multi-provider | Not started | Add `src/providers/snyk.js` etc |
| 3 — Multi-ecosystem | Not started | Add `src/ecosystems/pip/` etc |
| 4–9 | Future | New top-level modules |

Phase 2 addition will be zero-friction after this restructure: drop a new file in `src/providers/`, register it in `src/providers/index.js`. Same for ecosystems.

---

## Verification

```bash
# After restructure — same results as before
node mendfix.js analyze --report GH_ui-platform_dev-vulnerability-report.json
# Expected: 8 libraries, 22 CVEs, Phase A:5, B:0, C:3

node mendfix.js apply --report GH_ui-platform_dev-vulnerability-report.json \
  --package-json /path/to/package.json --verify-versions
# Expected: Phase A applied, npm install runs, lock verified, manifest written

# Idempotency check
node mendfix.js apply ... (same args again)
# Expected: "nothing to apply" — manifest matches current state
```

Update `CLAUDE.md` file table to reflect new paths after restructure.
