# Claude Operating Manual — Mend AutoFixer

This is where all future sessions continue. Read this before touching any code.

## Coding standards

- Plain Node.js (CommonJS `require`). No TypeScript. No build step.
- No frameworks, no DI, no ORM. Deps: `semver`, `xlsx` only.
- One file, one responsibility. No mixing parsing with output.
- No comments that explain *what* — only *why* when non-obvious.
- No error handling for internal code paths; validate only at CLI boundaries.

## Architecture

```
Provider (parser) → SemVer Engine → Phase Classifier → Registry Verify (optional) → Ecosystem Writer + Report
```

Folder layout — one concern per directory:

```
src/
  core/           — ecosystem-agnostic engine (stable across all phases)
  providers/      — one file per vulnerability report source (Mend, future: Snyk, Dependabot)
  ecosystems/
    npm/          — lock-parser, overrides, registry, installer
    maven/        — pom-writer, registry
```

| File | Owns |
|------|------|
| `src/providers/mend.js` | Parse Mend JSON + Excel reports → `LibraryEntry[]` |
| `src/providers/index.js` | Auto-detect provider from report format |
| `src/core/semver-engine.js` | Deterministic fix-version resolution per library |
| `src/core/phases.js` | Phase A/B/C classification + justification text |
| `src/core/report.js` | Generate markdown report (display only, no logic) |
| `src/core/confidence.js` | evidence + alternative fields (Scenario 14) |
| `src/core/git-commits.js` | Auto-commit by confidence tier (Scenarios 15/16) |
| `src/ecosystems/index.js` | Auto-detect ecosystem from library type |
| `src/ecosystems/npm/registry.js` | Async npm registry version check (Node 18+ fetch) |
| `src/ecosystems/npm/overrides.js` | Build phase-specific overrides maps; apply to package.json |
| `src/ecosystems/npm/lock-parser.js` | package-lock.json v2/v3 dep tree parser |
| `src/ecosystems/npm/installer.js` | npm install, rollback, lock verify, manifest |
| `src/ecosystems/maven/registry.js` | Maven Central version check |
| `src/ecosystems/maven/pom-writer.js` | Write + apply pom.xml dependencyManagement patches |
| `mendfix.js` | CLI — subcommands: analyze / apply / cleanup |
| `mend-fix.js` | Backward-compat shim → requires mendfix.js |

## 3-Phase model (MEND_AUTOMATION.md Step 7)

| Phase | Confidence | Criteria | Output |
|-------|-----------|----------|--------|
| A | 95-100% | Same-major patch/minor, single version in tree, verified on npm | `phase-a-overrides.json` — auto-apply |
| B | 60-95% | Multiple same-major versions of same package; forced override | `phase-b-overrides.json` — review first |
| C | <60% | MAJOR_BUMP; NO_FIX; multi-major version conflict | `manual-review.md` — justification required |

**Critical rules:**
- **MAJOR_BUMP always goes to Phase C** — never auto-apply (nanoid 3→5 example).
- **Multi-major version conflict always goes to Phase C** — a single `overrides` key cannot safely cover two major lines without nested parent overrides (requires package-lock.json analysis, Phase 2/3).
- **No `@^major` scoped selectors** in any overrides output — unreliable across npm versions.
- **`--package-json <path>` applies Phase A only** — automatic, no extra flag needed.

## Never break existing functionality

- `resolveFixVersion` handles: same-major safe, cross-major bump, no-fix, multi-CVE grouping. Do not simplify.
- Phase A overrides are clean `"pkg": "version"` — no selectors, no ranges.
- `applyOverridesToPackageJson` merges, never replaces, existing overrides.
- Registry check is always optional (`--verify-versions`); script must work without network.

## Build incrementally (phases from docs/04)

Done: Phase 1 (parse), Phase 4 (semver), Phase 5 (overrides), Phase 7 (report).
Next: Phase 2/3 — parse `package-lock.json`, build dependency tree.
  → Will unlock: nested parent overrides for multi-major conflicts (current Phase C → Phase B)
  → Will unlock: runtime vs build/dev classification (false positive detection)

Never implement future phases unless explicitly asked.

## Test after every change

```bash
node mendfix.js analyze --report GH_ui-platform_dev-vulnerability-report.json
```

Expected:
- 8 libraries, 22 CVEs
- Phase A: 5 (fast-uri, socket.io-parser, postcss, unzipper, axios)
- Phase B: 0
- Phase C: 3 (nanoid [MAJOR_BUMP], brace-expansion ×2 [multi-major conflict])
- Exit code 0

With registry check:
```bash
node mendfix.js analyze --report GH_ui-platform_dev-vulnerability-report.json --verify-versions
```

With auto-apply:
```bash
node mendfix.js apply --report GH_ui-platform_dev-vulnerability-report.json \
  --package-json /path/to/ui-platform/package.json --verify-versions
```

Post-install cleanup:
```bash
node mendfix.js cleanup \
  --package-json /path/to/ui-platform/package.json \
  --lock-file /path/to/ui-platform/package-lock.json
```

Legacy flag syntax still works (mend-fix.js shims to mendfix.js):
```bash
node mend-fix.js --report GH_ui-platform_dev-vulnerability-report.json --dry-run
```

## Script vs Claude division (SCRIPT_VS_CLAUDE_WORK_DIVISION.md)

Script owns everything deterministic:
- Parse, SemVer, dependency graph, overrides, npm install, verify lock, remove overrides, commits, report

Claude owns the uncertain 5-10%:
- Uncertain cases (Phase C justification review)
- False positive assessment (no-fix + build-only classification)
- Breaking change judgement (Phase C MAJOR_BUMP API compatibility)

## Session Log Rule

After every session that changes code, append one entry to `docs/SESSION_LOG.md`.

Format per entry:
```
## YYYY-MM-DD — <title>
**Before:** one line on the state before this session
**Changes:**
- bullet: what changed + why (why-focused, not what-focused)
**Next:** what's blocked or what comes after
```

Only write what a future Claude session needs to avoid re-deriving. Skip: debugging steps, things obvious from reading the code, one-off experiments. Include: architectural decisions, reversed decisions, non-obvious constraints, user feedback that shaped a direction.

## Key decisions

- **No AI for SemVer** — use `semver` package, always deterministic.
- **package-lock.json is source of truth** — when Phase 2/3 land, read from lock file, not `package.json` deps.
- **Override removed after install if unnecessary** — after `npm install`, if `npm ls pkg` resolves the fix version without the override, remove it.
- **No @^major selectors** — per user feedback, unreliable; multi-major conflict → Phase C.
- **Registry check is optional** — pass-through without network; phase is not downgraded if registry is unreachable (exists: null).
