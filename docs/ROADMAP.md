# Mend AutoFixer — Roadmap

Tracks feature status across sessions. Update this file whenever work starts or completes.
Read this at the start of any session to pick up where we left off.

---

## Done

| Feature | Notes |
|---------|-------|
| JSON report parsing | Groups by `library.keyUuid`; handles 3 `fixResolution` string formats |
| Excel report parsing | Auto-detects column names |
| SemVer engine | Deterministic: per-CVE min same-major fix → max across CVEs; MAJOR_BUMP / NO_FIX / SAFE |
| Phase A/B/C classification | A: same-major single version; B: same-major multi-instance; C: MAJOR_BUMP / NO_FIX / multi-major conflict |
| npm registry verification | `--verify-versions`; adjusts to nearest available ≥ fix; `exists: null` = pass-through (no phase downgrade) |
| Phase A auto-apply | `--package-json <path>` applies Phase A overrides directly; merges, never replaces |
| Output: phase-a/b-overrides.json | Clean `"pkg": "version"` — no `@^major` selectors |
| Output: phase-c-review.md | Per-item checklist with upgradeType-specific action items |
| Output: remediation-report.md | Full markdown report with all phases |
| CLAUDE_WORKFLOW.md | Step-by-step Claude instruction doc for Phase C triage (5-10% manual work) |
| Session log rule | CLAUDE.md rule + `docs/SESSION_LOG.md` maintained after each coding session |
| **package-lock.json dep tree** (`src/lock-parser.js`) | `--lock-file`; v2/v3 flat packages map; parent tracking with declared ranges |
| **Consumer range validation** | Phase A → B downgrade when consumer pinned range doesn't satisfy fix version |
| **Dev/build classification** | `probableFalsePositive: true` on NO_FIX items where all lock-file instances are `dev: true` |
| **Parent upgrade recommendations** | Phase C MAJOR_BUMP items gain `rootParents[]` — direct root deps that pull in the vulnerable package |
| **Stale override cleanup** (`--verify-overrides`) | Post-install: flags overrides where all consumer ranges cover fix version; removes from `package.json` |
| **Nested parent-scoped overrides** | Multi-major conflicts → Phase B when parents are disjoint; generates `"parent": { "pkg": "version" }` keys |
| **Dependency chain display** | Phase C items show `root → ... → vulnerablePkg` path via BFS from dep tree |
| **Phase B → A promotion** | Same-major multi-instance Phase B items auto-promoted when all consumer ranges are compatible |
| **`--out-dir` default** | Output now defaults to the report file's directory (not CWD `./mend-output`) |
| **Direct dep detection + priority order** (Scenarios 12/13) | `detectDirectDeps` in `src/overrides.js`; direct deps bump `dependencies`/`devDependencies`, transitive deps get `overrides` |
| **package-lock.json update + verification** (Scenario 5) | `runPackageLockUpdate` + `verifyFixVersions` in `src/install-runner.js`; runs `npm install --legacy-peer-deps --package-lock-only` then re-parses lock to confirm versions |
| **Rollback on install failure** (Scenario 22) | `snapshotFiles` / `restoreFiles` in `src/install-runner.js`; snapshots `package.json` + lock before any write, restores both on failure |
| **Preserve human changes** (Scenario 26) | `saveManifest` / `detectManualChanges` in `src/install-runner.js`; writes `.mend-manifest.json` after apply; skips overrides manually edited since last run |

---

## Todo

### Blocking Phase 1 — must complete before Phase 1 is done

- [x] **Direct dependency detection + priority order** (Scenarios 12/13) — `detectDirectDeps` in `src/overrides.js` splits Phase A items; direct deps get bumped in `dependencies`/`devDependencies`, transitive deps get an `overrides` entry. Range prefix (`^`, `~`) preserved.
- [x] **package-lock.json update execution** (Scenario 5) — `runPackageLockUpdate` in `src/install-runner.js` runs `npm install --legacy-peer-deps --package-lock-only` after applying changes; `verifyFixVersions` re-parses the updated lock and confirms each fixed package resolved correctly.
- [x] **Rollback on failure** (Scenario 22) — `snapshotFiles` / `restoreFiles` in `src/install-runner.js` snapshot both `package.json` and `package-lock.json` before any mutation; both are restored if install fails or throws.
- [x] **Preserve human changes** (Scenario 26) — `saveManifest` / `detectManualChanges` in `src/install-runner.js` write `.mend-manifest.json` after each successful apply; on the next run, any override whose current value differs from the manifest is skipped with a warning.

---

### Lower priority — Phase 2 and beyond

- [ ] **Idempotency guarantee** (Scenario 21) — running apply twice must produce no additional changes. Mostly falls out of Scenario 26 conflict detection but needs an explicit pass.
- [ ] **Auto git commits by confidence tier** (Scenarios 15/16) — Phase A: one commit for safe patch/minor updates. Phase B: separate commit for riskier overrides. Never mix tiers.
- [ ] **PR description generation** (Scenario 18) — auto-produce a PR body: packages fixed, CVEs closed, confidence breakdown, manual-review items, false positive count.
- [ ] **`manual-review.md` output** (Scenario 24) — consolidate Phase C output into `manual-review.md` as a structured checklist. Currently `phase-c-review.md`; rename + ensure nothing below confidence threshold is silently skipped.
- [ ] **`mendfix analyze` / `mendfix apply` subcommands** (Scenarios 19/20) — replace `--dry-run` / `--package-json` flags with proper subcommands. Current flags work; this is polish.
- [ ] **Full confidence metadata** (Scenario 14) — add `evidence` (specific data points) and `alternative` (next-best option) fields alongside existing `confidence` and `reason`. Current fields cover most real needs.
- [ ] **Deep runtime/dev chain classification** — currently `probableFalsePositive` only fires when ALL lock-file entries are `dev: true`. Tracing mixed chains (package reachable via both dev and prod paths) would be more accurate. Low priority: npm v7+ lock files already set `dev: false` for any package with a prod path, so the simple check covers most real cases.
- [ ] **Excel column auto-mapping improvements** — parser is flexible but may miss edge-case column names from different Mend report versions. Add test with a second sample Excel file when available.
- [ ] **`npm ls` output parser** — parse `npm ls --json` output to cross-check against our lock-file-based dep tree. Useful for validating dep-tree accuracy.

---

## Deferred / Won't do (with reason)

| Item | Reason |
|------|--------|
| AI-based SemVer resolution | Non-deterministic. `semver` package is the source of truth. |
| `@^major` scoped override selectors | Unreliable across npm versions. Multi-major → Phase C instead. |
| Backwards-compat shims for old output format | Not needed; no consumers of old format. |
| TypeScript rewrite | CLAUDE.md explicitly: plain CommonJS, no build step. |

---

## Priority order for next session

1. Deep runtime/dev chain classification for mixed paths (low priority — npm v7+ already handles most cases)
2. Test with a real ui-platform package-lock.json to validate all dep-tree features end-to-end
3. Excel column auto-mapping improvements (when a second sample file is available)
