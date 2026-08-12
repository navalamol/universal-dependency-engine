# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-12

---

## Phase 1 — ✅ COMPLETE (2026-08-12)

All 26 Phase 1 scenarios done. 48/48 tests passing. Regression baseline A:5 B:0 C:3 confirmed.

| Completed item | Date |
|----------------|------|
| git-commits.js wiring (`--commit` flag) | 2026-08-12 |
| PR description generation (`pr-description.js`) | 2026-08-12 |
| Maven dep-tree parser (`dep-tree.js`) | 2026-08-12 |
| V1 blockers (exit codes, control flow, Maven range field) | 2026-08-12 |
| `enrichWithConfidence` wired into mendfix CLI path | 2026-08-12 |

---

## Phase 1.x — Remediation Path Explorer (current)

### ~~Step A/B: Manifest inspection per candidate parent version~~ ✅ DONE 2026-08-12

- `registry.js` — added `getManifest(name, version)` with per-run cache (`_manifestCache`)
- `parent-upgrade-explorer.js` — removed local `fetchJson`/`getVersionDeps`; uses `getManifest` from registry; applies `CANDIDATE_LIMIT = 10` per level; adds `manifestVerified: true` to returned path objects

### ~~Step C: Isolated package-manager simulation~~ ✅ DONE 2026-08-12

- New `src/ecosystems/npm/simulator.js` — temp-dir npm install, lockfile inspection, hash cache, timeout, limit guardrails
- Wired into `parent-upgrade-explorer.js` — stamps `simulationVerified: true` on confirmed paths

### ~~Step E: Multi-path comparison + Change Budget ranking~~ ✅ DONE 2026-08-12

- New `src/core/remediation-paths.js` — `buildPaths`, `rankPaths`, `comparePaths`, `enrichWithPaths`
- Adds `recommendedPath`, `alternativePaths[]`, `decisionLabel` to every PhasedItem
- Wired into `mendfix.js` after `enrichWithConfidence`; `decisionLabel` now shown in report + manual-review.md
- 16 new tests; 48/48 total passing

### Next: Step D — Security verification in simulated graph

For each simulated `resolvedVersions` map, cross-reference against the current `LibraryEntry[]` finding set:
- For each package in `resolvedVersions`: check if any finding has same name AND simulated version is still in vulnerable range
- Surface: `newVulnerabilitiesIntroduced[]`, `existingVulnerabilitiesFixed[]`
- Feed into path ranking: a candidate that fixes CVE-A but introduces CVE-B is not a valid recommendation

**File:** extend `src/ecosystems/npm/simulator.js` or new `src/core/security-delta.js`
**Dependency:** Step C (simulation already done)

---

## Phase 1.x — After Step D: further enhancements

See `REMEDIATION_CAPABILITY_ROADMAP.md §11` for:
- Dependency blast radius (`src/ecosystems/npm/lock-parser.js` reverse-index)
- Safety Gate pre-edit checklist
- Mixed dev/runtime chain classification (Scenario 8 full)

---

## Phase 1 → Phase 1.x entry: Remediation Path Explorer (preserved)

**Phase 1 is complete (all conditions met as of 2026-08-12):**
- Test baseline holds: `node mendfix.js analyze --report ...` → Phase A:5, B:0, C:3 ✅
- All 26 scenarios verified ✅

**Phase 1.x entry point (Remediation Path Explorer):**

The core differentiator after V1. See `REMEDIATION_CAPABILITY_ROADMAP.md` for full detail.

Build sequence (3 steps):
1. **Manifest inspection per candidate parent version** — fetch `Y@candidate/package.json` from
   npm registry, extract declared child range, verify fixed child version satisfies it.
   Files: `src/ecosystems/npm/parent-upgrade-explorer.js`, `src/ecosystems/npm/registry.js`

2. **Isolated package-manager simulation** — new `src/ecosystems/npm/simulator.js`.
   For each viable candidate: write temp `package.json`, run `npm install --package-lock-only`,
   parse resulting lockfile, confirm vulnerable dep resolves to fixed version.
   This promotes INFERRED parent upgrade paths to VERIFIED.

3. **Multi-path comparison + Change Budget ranking** — collect all explored paths, rank by
   VERIFIED > INFERRED then by Change Budget tier (lockfile-only > parent minor > override).
   Phase A/B/C + decision label assigned after ranking from evidence.
   Files: new `src/core/remediation-paths.js`, extend `src/core/phases.js`

---

## Phase 2 entry criteria (Universal Finding Engine)

**Do NOT start Phase 2 until all three are true:**
1. Phase 1 gaps 1 and 2 above are closed
2. Test baseline holds: `node mendfix.js analyze --report ...` → Phase A:5, B:0, C:3
3. `mendfix apply` with a real project completes end-to-end: apply → install → verify → commit → pr-description.md

**Phase 2 entry point:**
- Create `src/providers/snyk.js` implementing `parse(filePath) → LibraryEntry[]`
- Register in `src/providers/index.js` — no changes to core
- Other providers: `dependabot.js`, `npm-audit.js`, `github-advisory.js`

---

## What NOT to do

- No TypeScript, build steps, or frameworks — ever
- No AI in the SemVer engine — it must stay deterministic
- No `@^major` selectors in overrides output
- No MAJOR_BUMP auto-applied — always Phase C
- No Phase 2 work until Phase 1 gaps 1 and 2 are closed

---

## Product context (one paragraph)

This is Phase 1 of a 9-phase Dependency Intelligence OS (see `Master_Roadmap.md`). The
provider/core/ecosystem separation built in Phase 1 is permanent infrastructure — it is what
makes Phases 2 and 3 cheap. Every interface decision (`LibraryEntry[]`, `ResolutionItem[]`,
`PhasedItem[]`) is load-bearing. Don't simplify what looks like over-engineering — it's the
foundation for millions of users. The Remediation Path Explorer (Phase 1.x) adds the
Find → Explore → Simulate → Verify → Compare → Recommend → Apply pipeline that makes parent
upgrade recommendations verified rather than inferred. See `REMEDIATION_CAPABILITY_ROADMAP.md`.
