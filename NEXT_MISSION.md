# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-12

---

## Phase 1 — Remaining gaps (ordered by priority)

Phase 1 is at ~99%. Two gaps remain before Phase 1 is complete.

### 1. Wire git-commits.js into mendfix.js apply (Scenarios 15/16)

`src/core/git-commits.js` is fully written and exports `commitPhaseA`, `commitPhaseBC`,
`commitFalsePositives`. It is **not called from mendfix.js apply** — needs wiring.

What to do:
- Add `--commit` flag to `mendfix apply`
- After Phase A is applied and install succeeds → call `commitPhaseA(projectDir, phaseAItems, ecosystem)`
- Document that Phase B/C commit (`commitPhaseBC`) is opt-in after human review
- Files: `mendfix.js` (apply block only), `src/core/git-commits.js` (already done)

### 2. Confidence enrichment in mendfix CLI path

`src/core/confidence.js` fields (evidence, alternative) are wired into the Renovate path
but **not into the main mendfix analyze/apply output**. Phase C items should carry full evidence.

- Wire `enrichWithConfidence` into `mendfix.js` analyze/apply output path
- File: `mendfix.js` + `src/core/confidence.js`

---

## Completed since last NEXT_MISSION.md update (2026-08-12 SESSION_LOG)

The following items were listed as gaps in the previous version but are now done:

| Item | Scenario | Status |
|------|----------|--------|
| PR description generation | 18 | `src/core/pr-description.js` written |
| Maven dep-tree parser | — | `src/ecosystems/maven/dep-tree.js` written |
| V1 blockers (exit codes, control flow, Maven dep-tree range field) | — | All fixed; 32/32 tests passing |

---

## Phase 1 → Phase 1.x entry: Remediation Path Explorer

**Phase 1 is complete when gaps 1 and 2 above are closed AND:**
- Test baseline holds: `node mendfix.js analyze --report ...` → Phase A:5, B:0, C:3
- `mendfix apply` with a real project completes end-to-end: apply → install → verify → commit → pr-description.md

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
