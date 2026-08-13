# Next Mission

Single source of truth for what to build next. Updated after each session.
**Last updated:** 2026-08-13

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

### ~~Steps 6–11: V1.x Enhancements~~ ✅ DONE 2026-08-12

| # | Enhancement | Status |
|---|-------------|--------|
| 6 | Security verification in simulated graph (`security-delta.js`) | ✅ DONE |
| 7 | Dependency blast radius (`buildBlastRadius` in `lock-parser.js`) | ✅ DONE |
| 8 | Safety Gate pre-edit checklist + `--verbose` / `--force` flags | ✅ DONE |
| 9 | Decision label taxonomy in Phase A/B report + PR description | ✅ DONE |
| 10 | Mixed dev/runtime chain classification (Scenario 8 full) | ✅ DONE |
| 11 | Renovate PR relationship analysis (`analyzePRRelationships`) | ✅ DONE |

---

### ~~Step G: Recursive parent-chain exploration with guardrails~~ ✅ DONE 2026-08-12

- `recursiveResolveChainChildRange` replaces `resolveChainChildRange` — explores all candidate versions at each intermediate hop (not just latest)
- All 9 guardrails applied: cycle detection, depth limit (5), candidate limit (10), simulation limit (20), registry cache, deterministic ordering
- Key invariant: function only propagates a child range if it covers `fixVersion` (checked at leaf)
- New CLI flags: `--max-depth`, `--max-simulations`
- 28 new tests in `tests/ecosystems/npm/parent-upgrade-explorer.test.js`
- 86/86 tests passing; regression baseline A:5 B:0 C:3 confirmed

---

## Phase 2 — Universal Finding Engine ✅ COMPLETE (2026-08-12)

### ✅ Step 1: Snyk provider — DONE 2026-08-12

- `src/providers/snyk.js` — `parseReport(filePath)` + `isSnykFormat(data)`
- Supports 3 Snyk output shapes: standard `snyk test --json`, `--all-projects`, flat array
- `src/providers/index.js` — Snyk detection wired before Mend fallback
- 20 new tests in `tests/providers/snyk.test.js`; 106/106 total passing; baseline A:5 B:0 C:3 confirmed

### ✅ Step V2-13: Override-set minimization — DONE 2026-08-12

- `src/ecosystems/npm/override-minimizer.js` — `minimizeOverrides()` iteratively simulates removal of each flat-string override via temp npm install; keeps only those still needed.
- `simulator.js` — added `simulatePackage(pkgObject, lockPath, opts)` export (takes a raw pkg object, not base+candidates).
- `mendfix cleanup --simulate` flag activates simulation path; `--max-simulations` also honored.
- 15 new tests in `tests/ecosystems/npm/override-minimizer.test.js` (simulator mocked).

### ✅ Step V2-14: Whole-graph before/after diff — DONE 2026-08-12

- `src/core/graph-diff.js` — `captureGraph(lockFilePath)` → `Map<name, string[]>`, `diffGraphs(before, after)` → `{added, removed, changed, unchangedCount}`, `formatDiff(diff, meta)` → markdown.
- Wired into `writeOutputNpm` in `mendfix.js`: captures lock state before install; after successful install diffs and writes `graph-diff.md` to `--out-dir`.
- 13 new tests in `tests/core/graph-diff.test.js`.
- 134/134 tests pass; baseline A:5 B:0 C:3 confirmed.

---

## Phase 5 — Multi-repo Portfolio Mode ✅ COMPLETE 2026-08-12

**`mendfix portfolio --config portfolio.json`** — analyze vulnerabilities across multiple repos in one run.

| Component | File | Status |
|-----------|------|--------|
| Portfolio orchestrator | `portfolio-runner.js` (root) | ✅ |
| Portfolio report generator | `src/core/portfolio-report.js` | ✅ |
| CLI subcommand `mendfix portfolio` | `mendfix.js` | ✅ |
| 25 runner tests | `tests/core/portfolio-runner.test.js` | ✅ |
| 20 report tests | `tests/core/portfolio-report.test.js` | ✅ |

332/332 tests pass. Baseline A:5 B:0 C:3 confirmed.

**Config format:**
```json
{
  "repos": [
    { "name": "org/repo", "report": "./vuln.json", "ecosystem": "npm", "lockFile": "./package-lock.json" }
  ],
  "outDir": "./portfolio-output",
  "verifyVersions": false
}
```

**Output:** `portfolio-output/portfolio-report.md` + per-repo `remediation-report.md` in `portfolio-output/<repo-name>/`.

All 9 providers complete: Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy, GitLab, Xray.

---

## Phase 6 — UI Layer (next major phase)

### Delivery decision

| Vehicle | Decision | Reason |
|---------|----------|--------|
| **VS Code Extension** | ✅ Primary | Devs already there; full Node.js host API; Webview panel; marketplace; workspace auto-detected |
| **Tauri standalone app** | ✅ Secondary | IDE-independent; ~10 MB (vs Electron 150 MB); shares 100% of frontend from extension |
| **Chrome Extension** | ✅ Companion (Step 6) | PR overlay badges only — cannot run shell commands or access filesystem |
| **Electron** | ❌ Rejected | Same capability as Tauri at 15× larger install size |

The extension wraps the existing CLI engine — no changes to `src/core/`, providers, or ecosystems.
The Webview (HTML/CSS/JS) communicates with the extension host (Node.js) via VS Code message-passing API.
Phase C items remain read-only in the UI — no auto-apply path exposed.

### Build sequence

| Step | Title | Files | Priority |
|------|-------|-------|----------|
| 1 | VS Code Extension Scaffold | `packages/vscode-extension/extension.js`, `panel.js`, `package.json` (vsce) | P1 |
| 2 | Report Upload & Analysis Panel | `report-view.html`, phase-cards, CVE table, provider auto-detect from file | P1 |
| 3 | Apply, Commit & PR Controls | apply flow, SecretStorage tokens, progress stream, rollback UI | P1 |
| 4 | Visual Settings & Portfolio Builder | settings form, portfolio.json builder, vsce publish | P2 |
| 5 | Tauri Standalone App (stretch) | Tauri sidecar, shared frontend from Steps 2–3, OS packaging, auto-update | P3 |
| 6 | Chrome Extension — PR Overlay (companion) | MV3 extension, GitHub/GitLab PR badges, local API bridge | P3 |

### Key architecture rules for Step 1
- Extension host (Node.js) owns all file I/O, `npm install`, `git` calls — same as the CLI
- Webview owns all UI rendering — posts messages to host, receives structured results
- Secrets (platform tokens) stored via `vscode.SecretStorage` — never in webview state
- `mendfix analyze` / `apply` / `portfolio` run via direct `require()` from the host, not child_process
- Test: existing 332 tests must still pass unchanged after scaffolding

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

## Phase 2 entry criteria ✅ MET (2026-08-12)

All three gate conditions were satisfied. Phase 2 is complete. Phase 3+ entry criteria TBD in Master_Roadmap.md.

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
