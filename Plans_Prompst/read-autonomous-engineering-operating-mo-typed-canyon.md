# Phase 6 Step 1 completion: settings expansion + panel repo controls

## Context

Three gaps remain after the Step 1 rework:

1. **What changed in panel.js and why** — the scaffold used `WebviewPanel` (editor tab, no icon) and
   stubbed all engine calls. The rework switched to `WebviewViewProvider` (sidebar, shield icon in
   Activity Bar) following the working reference pattern, and wired real engine calls via
   `detectProvider → getParser → parseReport`. The original `parseReport` import was wrong because
   `src/providers/index.js` does not export `parseReport` — it exports `detectProvider` + `getParser`.

2. **`verifyVersions` is received but never forwarded** — `_handleAnalyze(reportPath, verifyVersions)`
   accepts the flag but never passes it to any engine call. The registry check in
   `src/ecosystems/npm/registry.js` is opt-in via `verifyVersions: true`; without forwarding it,
   the checkbox in the panel does nothing.

3. **Only 2 settings exist** (`outDir`, `verifyVersions`). The CLI has ~20 meaningful flags that users
   need to configure per-repo: `--package-json`, `--lock-file`, `--ecosystem`, `--apply-phase-b`,
   `--commit`, `--pom-xml`, `--open-pr`, platform tokens, etc. Without these in the panel, the apply
   flow (Step 3) has nowhere to get its inputs from.

## Changes

### 1. `packages/vscode-extension/package.json` — expand contributes.configuration

Add all meaningful per-session flags as workspace settings (never user-level — these are repo-specific):

```
mendfix.packageJson       string   ""        Path to package.json for npm overrides
mendfix.lockFile          string   ""        Path to package-lock.json (enables dep-tree features)
mendfix.pomXml            string   ""        Path to pom.xml for Maven patches
mendfix.ecosystem         enum     "auto"    auto | npm | maven | python | go | dotnet | rust
mendfix.applyPhaseB       boolean  false     Also apply Phase B overrides (review first)
mendfix.autoCommit        boolean  false     Auto-commit Phase A fixes after successful install
mendfix.autoCommitPhaseB  boolean  false     Auto-commit Phase B fixes (requires applyPhaseB)
mendfix.dryRun            boolean  false     Print plan only; write nothing to disk
mendfix.verbose           boolean  false     Print Safety Gate checklist for every item
mendfix.openPr            boolean  false     Open a PR/MR after apply
mendfix.platform          enum     ""        github | gitlab | azuredevops | bitbucket
mendfix.prBase            string   "main"    Target branch for the PR
```

Secrets (tokens) stay out of settings — stored via `vscode.SecretStorage` in Step 3.

### 2. `packages/vscode-extension/panel.js` — three targeted changes

**a) Fix verifyVersions forwarding**
`buildResolutionPlan(entries)` takes only one argument — no opts. Registry verification is a
separate step in `mendfix.js` (line 713): after `buildResolutionPlan` returns, it calls
`verifyPlanVersions(plan)` from `src/ecosystems/npm/registry.js` when `verifyVersions` is true.

Wire this the same way in the extension:
```js
const REGISTRY_PATH = path.join(__dirname, '../../src/ecosystems/npm/registry.js');
// ...
let plan = buildResolutionPlan(entries);
if (verifyVersions) {
  const { verifyPlanVersions } = require(REGISTRY_PATH);
  plan = await verifyPlanVersions(plan);
}
const phasedItems = applyPhases(plan, null);
```

**b) Add "Repo target" section to the sidebar HTML**
Below the report file picker, add a collapsible "Repo target" section with:
- Package.json file picker (Browse button → stores path, reads `mendfix.packageJson` setting as default)
- Lock file picker (Browse button → reads `mendfix.lockFile` setting as default)
- Ecosystem dropdown (auto / npm / maven / python / go / dotnet / rust)
- Apply Phase B checkbox (reads `mendfix.applyPhaseB`)
- Dry run checkbox (reads `mendfix.dryRun`)

On `resolveWebviewView`, read current workspace settings and post them to the webview as an `init`
message so the UI pre-fills from saved config. Use `vscode.workspace.getConfiguration('mendfix')`.

**c) Add `openSettings` link always-visible** (not just after results)

### 3. Apply workflow explanation (for the guide doc)

How apply works end-to-end (so users understand what Step 3 will do):
1. User runs Analyze → sees Phase A/B/C split
2. User sets Repo target (package.json, lock-file)
3. User clicks "Apply Phase A" → extension host calls engine apply path:
   - `src/ecosystems/npm/overrides.js` writes overrides into package.json
   - `src/ecosystems/npm/installer.js` runs `npm install`, verifies lockfile
   - `src/ecosystems/npm/installer.js` rolls back on failure
   - If autoCommit: `src/core/git-commits.js` commits the changes
   - If openPr: `src/ecosystems/*/pr-poster.js` opens a PR via platform API
4. Progress streamed to webview via postMessage `{ type: 'applyProgress', line }`
5. Result posted as `{ type: 'applyResult', written: [...], committed: bool, prUrl }`

### 4. `docs/phase6-step1-guide.html` — update guide

Add sections:
- "What changed from scaffold to rework" — explains WebviewPanel vs WebviewViewProvider, the parseReport error, the fix
- "Apply Workflow" — the 5-step flow above with the flags involved
- "Configuring Repo Targets" — shows each new setting, when to use it, how it maps to CLI flags
- Update settings table with all new entries

## Files to modify
- `packages/vscode-extension/package.json` — contributes.configuration (add ~12 new settings)
- `packages/vscode-extension/panel.js` — verifyVersions fix, repo-target section in HTML, init message
- `packages/vscode-extension/docs/phase6-step1-guide.html` — new sections

## Verification
1. F5 in VS Code → shield icon appears → panel opens
2. Browse for report → Analyze → Phase A/B/C cards appear (confirm verifyVersions checkbox now
   actually hits registry when checked — check network activity or add a log)
3. VS Code Settings → search "mendfix" → all new settings visible with descriptions
4. Panel UI shows "Repo target" section with package.json + lock-file pickers and ecosystem dropdown
5. `npm test` from project root → 332/332 passing (no engine code changed)
