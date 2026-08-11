# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-11

---

## Phase 1 — Remaining gaps (ordered by priority)

Phase 1 is at ~97%. These four gaps remain before Phase 1 is complete.

### 1. Wire git-commits.js into mendfix.js apply (Scenarios 15/16)

`src/core/git-commits.js` is fully written and exports `commitPhaseA`, `commitPhaseBC`,
`commitFalsePositives`. It is **not called anywhere** — needs wiring into `mendfix.js apply`.

What to do:
- Add `--commit` flag to `mendfix apply`
- After Phase A is applied and install succeeds → call `commitPhaseA(projectDir, phaseAItems, ecosystem)`
- Document that Phase B/C commit (`commitPhaseBC`) is opt-in after human review
- Files: `mendfix.js` (apply block only), `src/core/git-commits.js` (already done)

### 2. PR description generation (Scenario 18)

After apply completes, write `mend-output/pr-description.md`.

Contents:
- Summary line: "X CVEs resolved across Y packages"
- Phase A table: package, current → fixed, CVE IDs
- Phase B table: same + "reviewed manually"
- Phase C section: link to manual-review.md for open items
- False positive count and list (if any)

Files: new `src/core/pr-description.js` + call from `mendfix.js apply` after all writes

### 3. Maven dep-tree parser (unlocks Phase B for Java)

`src/ecosystems/maven/dep-tree.js` — parse `mvn dependency:tree` text output into the same
`DepTree` shape (`Map<name, Entry[]>` with parents, ranges, dev flag) that `lock-parser.js` produces.

Unlocks:
- Nested parent-scoped overrides in pom.xml for multi-major conflicts (same logic as npm)
- Scope-based false positive detection (`test`/`provided` scope = build-only chain)

Files: new `src/ecosystems/maven/dep-tree.js`; wire into `mendfix.js` via `--maven-dep-tree <path>` flag

### 4. Deep mixed dev/runtime chain classification (Scenario 8 full)

Currently `probableFalsePositive` fires only when ALL lock-file entries are `dev: true`.
Mixed chains (package reachable via both dev and prod paths) are left unclassified.

What's needed: recursive parent chain walk — if every prod path is through a `devDependencies` root,
classify as dev-only. Complex, but unlocks more Phase C → false positive promotions.

Defer unless a real project has mixed-chain flooding Phase C with false positives.

---

## Phase 1 → Phase 2 entry criteria

**Do NOT start Phase 2 until all three are true:**
1. Gaps 1 and 2 above are closed (git commits + PR description)
2. Test baseline holds: `node mendfix.js analyze --report ...` → Phase A:5, B:0, C:3
3. `mendfix apply` with a real project completes end-to-end: apply → install → verify → commit → pr-description.md

**Phase 2 entry point (Universal Finding Engine):**
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
foundation for millions of users.
