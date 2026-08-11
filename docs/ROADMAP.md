# Mend AutoFixer — Feature Tracker

Tracks feature completion across sessions. See `NEXT_MISSION.md` for what to build next.

---

## Done

| Feature | Notes |
|---------|-------|
| JSON report parsing | Groups by `library.keyUuid`; handles 3 `fixResolution` string formats + Maven GAV |
| Excel report parsing | Auto-detects column names |
| SemVer engine | Deterministic: per-CVE min same-major fix → max across CVEs; MAJOR_BUMP / NO_FIX / SAFE |
| Phase A/B/C classification | A: same-major single version; B: same-major multi-instance; C: MAJOR_BUMP / NO_FIX / multi-major |
| npm registry verification | `--verify-versions`; adjusts to nearest available ≥ fix; `exists: null` = pass-through |
| Phase A auto-apply | `--package-json <path>` applies Phase A overrides directly; merges, never replaces |
| Output: phase-a/b-overrides.json | Clean `"pkg": "version"` — no `@^major` selectors |
| Output: manual-review.md | Phase C structured checklist with upgradeType-specific action items (renamed from phase-c-review.md) |
| Output: remediation-report.md | Full markdown report with all phases, dep chains, confidence |
| CLAUDE_WORKFLOW.md | Step-by-step Claude triage doc for Phase C items |
| package-lock.json dep tree | `src/ecosystems/npm/lock-parser.js`; v2/v3 flat packages map; parent tracking with declared ranges |
| Consumer range validation | Phase A → B downgrade when consumer pinned range doesn't satisfy fix version |
| Dev/build classification | `probableFalsePositive: true` when all lock-file instances are `dev: true` |
| Parent upgrade recommendations | Phase C MAJOR_BUMP items gain `rootParents[]` |
| Stale override cleanup | `mendfix cleanup`; flags/removes overrides where consumer ranges already cover fix |
| Nested parent-scoped overrides | Multi-major disjoint parents → Phase B; generates `"parent": { "pkg": "version" }` keys |
| Dependency chain display | Phase C items show `root → ... → vulnerablePkg` path via BFS |
| Phase B → A promotion | Same-major multi-instance Phase B auto-promoted when all consumer ranges satisfied |
| `--out-dir` default | Now relative to the report file's directory, not CWD |
| Direct dep detection + priority (Scenarios 12/13) | Direct deps bump `dependencies`/`devDependencies`; transitive → `overrides` |
| package-lock.json update + verify (Scenario 5) | `runPackageLockUpdate` + `verifyFixVersions` in installer.js |
| Rollback on install failure (Scenario 22) | `snapshotFiles` / `restoreFiles` in installer.js |
| Preserve human changes (Scenario 26) | `.mend-manifest.json` — skips manually-edited overrides with warning |
| **Maven support** | maven/registry.js + pom-writer.js; auto-detects MAVEN_ARTIFACT; `--pom-xml` apply flag |
| **Folder restructure** | src/core/, providers/, ecosystems/npm/, ecosystems/maven/ — zero-friction Phase 2/3 extension |
| **mendfix.js subcommands** (Scenarios 19/20) | analyze / apply / cleanup; mend-fix.js kept as shim |
| **Idempotency pre-flight** (Scenario 21) | Pre-flight check against .mend-manifest.json before any writes |
| **Confidence metadata** (Scenario 14) | confidence.js — evidence + alternative fields per resolution item |
| **git-commits.js** (Scenarios 15/16 — partial) | File written; commitPhaseA/B/C functions ready; **not yet called from mendfix.js apply** |

---

## Remaining — Phase 1 gaps

| Feature | Scenario | Status |
|---------|----------|--------|
| Wire git-commits.js into mendfix.js apply | 15/16 | File exists; needs wiring + `--commit` flag |
| PR description generation | 18 | Not started; needs `src/core/pr-description.js` |
| Maven dep-tree parser | — | Not started; `src/ecosystems/maven/dep-tree.js` |
| Deep mixed dev/runtime chain classification | 8 full | Deferred; current all-dev check covers most real cases |

---

## Deferred / Won't do

| Item | Reason |
|------|--------|
| AI-based SemVer resolution | Non-deterministic. `semver` package is the source of truth. |
| `@^major` scoped override selectors | Unreliable across npm versions. Multi-major → Phase C. |
| TypeScript rewrite | CLAUDE.md explicitly prohibits. Plain CommonJS only. |
| Backwards-compat shims for old output | No consumers of old format. |
