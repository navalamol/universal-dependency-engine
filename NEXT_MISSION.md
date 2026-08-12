# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-12

---

## Phase 1 — ✅ COMPLETE (2026-08-12)

All 26 Phase 1 scenarios done. 32/32 tests passing. Regression baseline A:5 B:0 C:3 confirmed.

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
- All previous `getVersionDeps` calls now go through the shared cached registry function

### Next: Step C — Isolated package-manager simulation

**File to create:** `src/ecosystems/npm/simulator.js`

```js
// Returns SimulationResult[]
simulate(basePackageJsonPath, baseLockPath, candidates, options)

// SimulationResult shape:
{
  candidate: { name, from, to },
  success: boolean,
  resolvedVersions: Map<name, version>,
  peerConflicts: string[],
  timedOut: boolean
}
```

Implementation:
1. Create temp directory
2. Copy `package.json` + `package-lock.json` into temp dir
3. Apply candidate version change to temp `package.json`
4. Run `npm install --package-lock-only --legacy-peer-deps` with 30s timeout
5. Parse resulting `package-lock.json` using existing `lock-parser.js`
6. Return `resolvedVersions` map + `peerConflicts`
7. Clean up temp dir unconditionally

Apply all guardrails from `REMEDIATION_CAPABILITY_ROADMAP.md §7`:
- Timeout per simulation (30s default)
- Simulation limit per run (20 default) — fail-open to INFERRED on limit
- Hash-based simulation cache: `hash(package.json state)` → `SimulationResult`
- Clean temp directories unconditionally

After simulator.js exists: wire into `parent-upgrade-explorer.js` — for each manifest-verified candidate, simulate to promote from INFERRED → VERIFIED.

---

## Phase 1.x — After simulation is stable

See `REMEDIATION_CAPABILITY_ROADMAP.md §11` for:
- Multi-path comparison + Change Budget ranking (`src/core/remediation-paths.js`)
- Security verification in simulated graph
- Dependency blast radius
- Safety Gate pre-edit checklist
- Decision label taxonomy

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
