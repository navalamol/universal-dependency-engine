# Dependency Intelligence Engine — Phase 5.5 and Phase 5.6 Master Execution Prompt

Treat the attached/latest repository as the single source of truth. Do not rely on earlier chat history where it conflicts with the source.

Your job is not only to create a plan. Reconcile the roadmap with the actual implementation, update the required project documents, and then begin implementation of the next approved mission.

## 1. Product vision

This product is evolving from a Mend/npm autofixer into an enterprise-grade Dependency Intelligence Engine.

Its core differentiator is:

> Deterministically explore, simulate, verify, compare and apply the safest dependency-remediation path, while producing evidence that an enterprise security team can independently audit.

The long-term remediation ladder is:

1. Prove exposure and exploitability context.
2. Upgrade the vulnerable dependency directly.
3. Upgrade or change the root parent dependency.
4. Remove an unused dependency or feature.
5. Replace the dependency with a maintained alternative.
6. Navigate a major-version migration.
7. Apply a verified local patch or upstream backport.
8. Use a governed internal fork.
9. Generate a candidate fix with LLM assistance.
10. Apply temporary compensating controls.
11. Prepare coordinated upstream disclosure or contribution.

The deterministic engine remains authoritative. AI may assist difficult engineering work later, but it must never replace deterministic resolution, verification, policy gates or human approval.

---

# 2. Operating instructions

## Read only the minimum required context first

Read:

* `CLAUDE.md`
* `Master_Roadmap.md`
* `NEXT_MISSION.md`
* `CODEBASE.md`
* `docs/ROADMAP.md`
* Relevant source and tests needed for the current mission

Do not read `Plans_Prompst/` or old historical planning documents unless a specific implementation ambiguity cannot be resolved from current source.

## Source truth and status reconciliation

Do not trust completion statements without validating the implementation.

Before changing code:

1. Run the clean test baseline.
2. Run the documented smoke/regression baseline.
3. Verify the actual CLI, extension and portfolio execution paths.
4. Identify stale or contradictory status claims.
5. Check whether all current JavaScript files parse.
6. Record only material discrepancies.

Known discrepancies to validate include:

* `CLAUDE.md` may describe git commit wiring as incomplete while other documents mark it complete.
* `CODEBASE.md` may contain duplicated Phase 4 status.
* The VS Code extension analysis path may bypass dependency-tree, confidence and remediation-path enrichment used by the CLI.
* The extension may describe SecretStorage/PR integration that is not fully wired.
* Some installers may construct shell command strings using package names or user/report-derived paths.
* Credentials may be accepted through command-line arguments and exposed through shell history or process listings.

These are observations to validate, not assumptions to blindly encode.

## Token and execution discipline

Prioritize implementation and verification:

* Approximately 70% implementation.
* Approximately 20% tests and verification.
* At most 10% planning, commentary and documentation maintenance.
* Do not repeatedly re-audit unchanged areas.
* Do not generate large speculative design documents.
* Batch work into no more than three coherent deliverables.
* Make safe, reversible assumptions for minor ambiguity.
* Stop only for a genuine security, legal, credential or destructive-action blocker.

Use a strong coding model with high reasoning for Phase 5.5 Missions 1–2 and Phase 5.6 D3. Do not use a lightweight model for security boundaries, process execution, evidence integrity or patch generation.

## Permanent architecture rules

Preserve these invariants unless source proves they have already intentionally changed:

* `LibraryEntry[]`, `ResolutionItem[]`, `PhasedItem[]` and `DepTree` remain stable interfaces.
* `src/core/` must not import providers or ecosystems.
* Put cross-layer orchestration in a separate orchestration/engine layer, not inside isolated core logic.
* No AI in SemVer resolution or Phase A/B/C classification.
* Major upgrades remain manual/high-risk unless a future explicit policy changes this.
* Incomplete evidence must never increase confidence.
* Phase C must never become auto-apply merely because an LLM recommends a fix.
* Preserve backward-compatible CLI behaviour wherever safely possible.
* Existing regression fixtures and Phase A/B/C baseline must continue to pass.
* Do not build Tauri, Electron or Chrome extensions in these phases.
* The VS Code extension must remain a thin client over the canonical engine.
* Focus new deep-remediation functionality on npm/JavaScript/TypeScript first. Keep interfaces extensible, but do not pretend all ecosystems have equal production depth.
* Never fabricate pilot, benchmark or remediation-success results.

---

# 3. Final roadmap structure

Update `Master_Roadmap.md` to reflect this sequence:

1. Existing completed deterministic/provider/ecosystem/platform phases.
2. **Phase 5.5 — Enterprise Trust and Pilot Release**
3. **Phase 5.6 — Deep Remediation Intelligence**
4. **Phase 6 — Focused UI Layer**
5. **Phase 7 — Dependency Outcome Knowledge Graph**
6. **Phase 8 — Organization-Specific Dependency Intelligence**
7. **Phase 9 — LLM-Assisted Intelligence**
8. **Dependency Intelligence OS**

Do not delete valid existing history. Reconcile it and clearly distinguish:

* Completed and verified.
* Implemented but not independently verified.
* Planned.
* Blocked by external pilot input.

The immediate execution priority is Phase 5.5 Mission 1.

Record all Phase 5.5 and Phase 5.6 missions in `NEXT_MISSION.md`, but only one mission should be marked current/in progress.

Avoid creating duplicate roadmap files. Use existing master roadmap, mission tracker and codebase reference as canonical planning documents.

---

# 4. Phase 5.5 — Enterprise Trust and Pilot Release

## Mission 1 — Security and canonical-engine closure

### Objective

Make CLI, UI, portfolio and future CI integrations consume one canonical decision pipeline, and remove product-security weaknesses before any external pilot.

### M1.1 Secure process execution

Find every use of:

* `exec`
* `execSync`
* `spawn`
* `spawnSync`
* `shell: true`
* Dynamically constructed command strings

Implement a centralized safe process-execution utility.

Required properties:

* Executable and arguments are separated.
* Shell interpretation is disabled by default.
* Only explicitly approved package-manager and build executables may run.
* Package names, versions, repository paths and report paths are validated.
* Reject control characters, shell metacharacters and invalid package identifiers.
* Resolve and validate working directories.
* Apply timeouts and output-size limits.
* Return structured results: exit code, signal, duration, stdout, stderr and redacted command representation.
* Redact tokens, passwords, authorization headers and credential-bearing URLs.
* Do not log full environment variables.
* Forward only necessary environment variables.
* Provide safe, explicit Windows handling for `.cmd` tools without reintroducing generic shell injection.
* Add malicious-input tests for paths, package names, versions and command arguments.
* Preserve required npm, Maven, Python, Go, .NET and Rust behaviour.

Replace vulnerable command-string construction in ecosystem installers/simulators.

If some platform requires a shell, isolate it behind a narrowly allowlisted adapter with strict argument validation and tests. Do not expose a general arbitrary-shell API.

### M1.2 Credential handling

* Stop encouraging tokens as ordinary CLI arguments.
* Preserve compatibility only if necessary, but emit a deprecation/security warning.
* Prefer environment injection, VS Code SecretStorage or short-lived platform credentials.
* Never include credentials in reports, evidence, errors, process output or generated PR descriptions.
* Sanitize Git URLs and HTTP errors.
* Add redaction tests with representative GitHub, GitLab, Azure DevOps and Bitbucket token formats.
* Ensure the extension actually uses SecretStorage before claiming that it does.
* Do not send or create external PRs during tests.

### M1.3 Canonical orchestration API

Create one canonical orchestration layer used by:

* CLI analysis.
* CLI apply.
* Portfolio mode.
* VS Code analysis.
* Future CI integrations.

The orchestration layer should expose clear structured operations such as:

* Analyze.
* Plan.
* Apply.
* Verify.
* Generate evidence.

Adapt naming to the current architecture rather than forcing these exact names.

The canonical analysis pipeline must include, when applicable:

1. Provider detection and parsing.
2. Ecosystem detection.
3. Lock/dependency graph loading.
4. Deterministic resolution.
5. Phase classification.
6. Confidence enrichment.
7. Remediation-path exploration/comparison.
8. Security delta and blast-radius data.
9. Policy evaluation.
10. Structured result generation.

Requirements:

* CLI and UI must not independently reimplement this pipeline.
* The VS Code extension must not spawn the CLI to obtain decisions.
* Long-running apply operations may use a structured worker abstraction if necessary, but decisions still come from the same orchestration API.
* Provide structured progress events for CLI/UI/CI consumers.
* UI, CLI and portfolio results for identical inputs must be semantically identical.
* Preserve existing stable interfaces.
* Add contract tests comparing results across entry points.

### M1.4 Product threat model and trust boundaries

Add concise, implementation-linked documentation covering:

* Assets protected.
* Attackers and malicious input sources.
* Vulnerability reports as untrusted input.
* Package manifests and registry metadata as untrusted input.
* Dependency lifecycle scripts.
* Local filesystem boundaries.
* Repository write permissions.
* Git platform credentials.
* CI credentials.
* External registry and platform network access.
* VS Code webview boundary.
* LLM boundary reserved for later phases.
* External disclosure boundary.
* Closed-source/licensed package boundary.

Include:

* Data-flow diagram.
* Trust-boundary diagram.
* Threats and mitigations.
* Residual risks.
* Required privileges.
* Network egress.
* Data retention.
* Explicit non-goals.

Prefer a small number of maintained documents such as:

* `docs/THREAT_MODEL.md`
* `docs/SECURITY_ARCHITECTURE.md`

Do not create overlapping documentation.

### M1.5 Reproducible clean CI

Add or repair CI so a clean checkout:

1. Installs dependencies deterministically.
2. Runs syntax/static checks.
3. Runs all tests.
4. Runs the regression/smoke fixture.
5. Validates documentation/status consistency where practical.
6. Publishes machine-readable test results.
7. Does not require real secrets.
8. Does not make external repository changes.
9. Uses least-privilege workflow permissions.
10. Fails on test or baseline regression.

Include tests for:

* Canonical entry-point equivalence.
* Command injection resistance.
* Credential redaction.
* Rollback behaviour.
* Phase A/B/C regression.
* UI/CLI decision parity.

### M1.6 Documentation reconciliation

Update:

* `CLAUDE.md`
* `Master_Roadmap.md`
* `NEXT_MISSION.md`
* `CODEBASE.md`
* `docs/ROADMAP.md`
* `docs/SESSION_LOG.md`
* `README.md` only where user-facing behaviour changed

Rules:

* Remove contradictory status.
* Remove duplicate rows.
* Do not claim features that are only configured but not wired.
* Keep a clear distinction between implementation and verification.
* Update file maps and exported functions.
* Keep `NEXT_MISSION.md` concise and executable.

### Mission 1 exit gate

Mission 1 is complete only when:

* The clean test suite passes.
* Existing smoke/regression baseline passes.
* Identical fixtures produce equivalent decisions through CLI, UI adapter and portfolio adapter.
* No report-derived package value is interpolated into a generic shell command.
* Credential-redaction tests pass.
* Extension functionality matches its documented claims.
* Threat model and trust boundaries reflect actual code.
* All current status documents agree.

Do not mark Mission 1 complete if any exit condition remains unverified.

---

## Mission 2 — Verified remediation evidence

Begin Mission 2 only after Mission 1 passes.

### Objective

A Phase A fix must become reproducible and independently explainable—not merely a version recommendation that happened to install.

### M2.1 Configurable build and test verification

Add policy-controlled verification commands.

Requirements:

* Commands use the safe process utility.
* Store executable and arguments separately.
* No arbitrary shell string by default.
* Support timeout and resource limits.
* Allow repository-specific build/test/lint/typecheck commands.
* Record tool versions and execution results.
* Allow required and optional checks.
* Required-check failure prevents a verified Phase A outcome.
* Missing required verification fails closed.
* Never auto-discover and execute unknown package scripts without policy approval.

### M2.2 Post-remediation rescan

Create a scanner/rescan adapter interface.

Support:

* Running a configured scanner command safely.
* Consuming a newly generated post-remediation report.
* Comparing original and post-remediation findings.
* Confirming target CVEs are gone.
* Detecting newly introduced findings.
* Recording when rescan capability is unavailable.

Do not falsely mark a finding fixed if a required rescan did not execute.

Distinguish:

* `RESOLVED_AND_RESCANNED`
* `RESOLVED_NOT_RESCANNED`
* `INSTALL_VERIFIED_ONLY`
* `VERIFICATION_FAILED`

Only the policy-approved highest state may qualify for fully verified auto-remediation.

### M2.3 Fail-closed safety gate

Phase A application must fail or downgrade when required evidence is uncertain:

* Install failed.
* Lock graph could not be read.
* Target version is missing.
* Unexpected version remains.
* Security delta is incomplete.
* New high-risk vulnerabilities appear.
* Required build/test failed.
* Required rescan failed or was unavailable.
* Working tree rollback could not be confirmed.
* Evidence serialization failed.

Do not silently continue with optimistic confidence.

### M2.4 Canonical evidence model

Create a versioned, machine-readable evidence schema.

At minimum capture:

* Schema and engine version.
* Invocation ID and timestamps.
* Repository/commit identity without credentials.
* Input report digest.
* Manifest and lockfile digests.
* Provider and ecosystem.
* Original finding.
* Dependency paths.
* Exposure context when available.
* Candidate remediation paths.
* Selected path and rejected alternatives.
* Phase/confidence and policy decision.
* Registry/manifest evidence.
* Before/after dependency graph.
* Security delta.
* Blast radius.
* Files changed.
* Install/build/test/rescan results.
* Rollback result.
* Tool versions.
* Human approvals when applicable.
* Final outcome taxonomy.
* Redacted errors.
* Evidence digest.

Outputs:

* Canonical JSON evidence.
* Human-readable remediation report.
* PR summary generated from canonical evidence.
* SARIF export.
* CycloneDX/VEX-compatible output where semantically appropriate.

The human report, UI and PR description must be views of canonical evidence—not separate decision sources.

Validate outputs against documented schemas where possible.

### M2.5 Outcome taxonomy

Introduce and document at least:

* `FIXED`
* `NOT_AFFECTED`
* `MITIGATED`
* `PATCHED`
* `FORKED`
* `ACCEPTED_RISK`
* `LICENSE_BLOCKED`
* `VERIFICATION_FAILED`
* `REQUIRES_MIGRATION`
* `NO_SAFE_PATH`

Do not confuse:

* Vulnerability absence.
* Contextual non-applicability.
* Temporary mitigation.
* Local patching.
* Risk acceptance.

### M2.6 Benchmark corpus and metrics

Create a legal, anonymized benchmark framework using synthetic or approved fixtures.

Do not include proprietary source or vulnerability reports without authorization.

Measure:

* Total findings.
* Eligible auto-remediation findings.
* Correct Phase A decisions.
* Build/test pass rate.
* Rescan closure rate.
* New vulnerabilities introduced.
* Rollback success.
* Unsupported/no-safe-path cases.
* False-safe decisions.
* Human intervention required.
* Time taken.

Tests must validate the benchmark calculation itself.

Do not fabricate headline percentages. Report only measured results from checked-in fixtures and later approved pilots.

### Mission 2 exit gate

Mission 2 is complete only when:

* Every verified Phase A fixture has a complete canonical evidence bundle.
* Required install/build/test/rescan failures downgrade or block the result.
* Evidence can reproduce why a path was selected.
* Human report, SARIF and VEX/SBOM views are traceable to the same evidence object.
* Benchmark metrics are reproducible.
* No unverified result is labelled fully verified.

---

## Mission 3 — Paid-pilot delivery

Begin only after Missions 1 and 2 pass.

### Objective

Package the engine for a controlled enterprise pilot and measure security and engineering outcomes.

### M3.1 CI integrations

Implement production-quality pilot integration for:

1. GitHub Actions.
2. Azure DevOps, if the current codebase and available effort permit it.

Requirements:

* Least-privilege permissions.
* No long-lived token in logs or artifacts.
* Dry-run default.
* Changes occur on a dedicated branch.
* No direct write to protected/default branches.
* Approval required before Phase B or any nonstandard path.
* Build/test/rescan gates execute before PR creation.
* Evidence is uploaded as an artifact.
* Check status clearly reports pass, fail, blocked or manual review.
* Platform adapters consume canonical orchestration/evidence APIs.

### M3.2 Repository policy file

Create a versioned repository policy schema, for example `.dependency-intelligence.yml` or an equivalent current-project convention.

Possible policies:

* Allowed automatic phases.
* Severity threshold.
* Runtime versus dev dependency rules.
* Maximum change-budget tier.
* Maximum blast radius.
* Required build/test/rescan commands.
* Registry allowlist.
* Package denylist.
* Major-upgrade prohibition.
* Required reviewers.
* Freeze windows.
* Allowed network egress.
* Fail-closed requirements.
* Evidence retention.
* Whether upstream issue/PR preparation is allowed.

Provide schema validation, helpful errors and safe defaults.

### M3.3 Audit trail

Generate append-only structured audit events for:

* Analysis.
* Policy decision.
* Candidate selection.
* Apply.
* Verification.
* Approval.
* PR creation.
* Rollback.
* Exception/risk acceptance.

Avoid pretending a local file is fully tamper-proof. If hash chaining or signing is implemented, document precisely what integrity guarantee it provides.

### M3.4 Pilot KPI report

Generate a pilot report containing:

* Findings analyzed.
* Findings safely remediated.
* Build/test pass rate.
* Rescan closure rate.
* Human review count.
* Median remediation time.
* Engineer time estimate with methodology.
* Failed/rolled-back attempts.
* New findings introduced.
* PR acceptance/merge status.
* Open manual-review items.

Create an executive case-study template, but never invent data.

### M3.5 Pilot runbook

Add a concise pilot runbook covering:

* Repository selection.
* Permission requirements.
* Data handling.
* Dry run.
* Policy review.
* Applying Phase A.
* Evidence review.
* Approval.
* Rollback.
* Incident handling.
* KPI collection.
* Pilot completion decision.

Running against 3–5 real repositories is an external gate. If repositories are not supplied, complete the infrastructure and mark actual pilot execution as `BLOCKED_EXTERNAL_INPUT`, not complete.

### Mission 3 exit gate

* Pilot infrastructure passes synthetic/local integration tests.
* At least one end-to-end test repository completes scan → plan → apply → build/test → rescan → evidence → draft PR without real external mutation.
* Policy and approval gates are enforced.
* Real pilot results remain pending until approved repositories are supplied.
* Executive report is generated only from actual collected data.

---

# 5. Phase 5.6 — Deep Remediation Intelligence

Fully document this phase now. Do not start it until the applicable Phase 5.5 gates pass.

The distinguishing product principle is:

> When ordinary scanners stop at “no fix” or “major upgrade required,” this engine explores deeper, governed engineering escape paths.

## D1 — Exposure, removal and preventive hygiene

**Effort:** low–medium
**Value:** very high

### D1.1 Exposure classification

Classify vulnerable packages as:

* `RUNTIME_REACHABLE`
* `PRODUCTION_BUNDLED`
* `BUILD_TIME_EXECUTED`
* `CI_EXECUTED`
* `TEST_ONLY`
* `LOCAL_TOOLING_ONLY`
* `INSTALLED_NOT_USED`
* `NOT_IN_PRODUCTION_ARTIFACT`
* `UNKNOWN_EXPOSURE`

Use evidence from:

* Lockfile dependency flags.
* Root dependency classification.
* Import/require usage.
* Build configuration.
* Package lifecycle scripts.
* Bundled production artifacts when available.
* Container/serverless artifact contents when supplied.
* CI scripts.
* Dependency path.

A `devDependency` flag alone must never imply “not critical.” Build and CI dependencies can execute with powerful credentials or influence production artifacts.

Preserve original vulnerability severity. Add environmental exposure and remediation priority separately.

### D1.2 Unused dependency and dependency-removal intelligence

Detect:

* Direct dependencies with no supported usage evidence.
* Dependencies used only by removed/disabled features.
* Duplicate packages providing the same capability.
* Dependencies replaceable by native Node/browser APIs.
* Root parents that exist only to introduce an obsolete transitive chain.

Static analysis can produce false positives due to dynamic imports, configuration-driven loading and plugins. Therefore:

* Report confidence and evidence.
* Draft removal in an isolated branch.
* Require build/test/bundle verification.
* Do not silently remove uncertain packages.

### D1.3 Dependency retirement signals

Assess:

* Official deprecation.
* Archived repository.
* Maintenance/release history.
* Security-policy availability.
* Runtime compatibility.
* Open unresolved security issues.
* Maintainer concentration.
* Install scripts.
* License risk.
* Internal incident history.
* Availability of maintained alternatives.

Inactivity alone must not mark a mature stable package unsafe.

Produce:

* Continue.
* Monitor.
* Isolate behind adapter.
* Replace.
* Fork temporarily.
* Retire/remove.

### D1.4 Preventive Dependency Hygiene

Keep preventive upgrades separate from active vulnerability remediation.

Use available npm primitives and registry information to identify:

* Versions available within existing ranges.
* Same-major patch/minor updates.
* Packages several majors behind.
* Deprecated packages.
* High-centrality dependencies.
* Duplicate versions.
* Git/branch dependencies.
* Packages with lifecycle scripts.
* Runtime/engine incompatibilities.
* Very new releases that should respect a configurable minimum release age.

Do not equate latest with safest.

Preventive changes must:

* Use separate PRs.
* Respect change budgets.
* Run canonical verification.
* Avoid mixing ordinary hygiene with emergency CVE fixes.
* Default to recommendation rather than auto-application.

### D1 exit gate

* Exposure claims include evidence and confidence.
* Dev-only packages are not incorrectly dismissed.
* Removal suggestions are validated in isolated tests.
* Preventive upgrades are separated from vulnerability remediation.
* Outcome taxonomy is used consistently.

---

## D2 — Replacement and Major Migration Navigator

**Effort:** medium
**Value:** very high

### D2.1 API usage fingerprint

For npm/JavaScript/TypeScript first, inspect:

* Imports and requires.
* Imported symbols.
* Constructor/function usage.
* Options/configuration.
* Error handling.
* Extension/plugin mechanisms.
* Runtime-specific adapters.
* Tests demonstrating expected behaviour.

Create a capability fingerprint describing what the application actually uses, not everything the library supports.

### D2.2 Alternative-package intelligence

Generate two or three candidates from:

* Curated package replacement catalogue.
* Organization-approved packages.
* Native platform APIs.
* Previously successful organizational migrations.
* Verified registry/repository metadata.
* LLM suggestions only as untrusted discovery input.

Score:

* Required capability coverage.
* Security history.
* Maintenance health.
* License compatibility.
* Migration effort.
* Runtime compatibility.
* Peer dependency impact.
* Bundle/performance impact.
* Install-script/native-code risk.
* Organizational experience.
* Testability and rollback.

Do not recommend deprecated or abandoned alternatives merely because they have similar keywords.

### D2.3 Migration strategy

Compare:

* Direct upgrade.
* Major-by-major migration.
* Adapter/compatibility layer.
* Strangler migration.
* Dual-run/differential migration.
* Internal fork as a temporary bridge.
* Feature removal.

Generate:

* Relevant breaking changes.
* Used APIs affected.
* Required runtime/peer upgrades.
* Files likely to change.
* Codemod opportunities.
* Missing tests.
* Proposed PR sequence.
* Rollback plan.
* Effort/confidence estimate.

Create a separate `major-migration-plan.md` or structured equivalent derived from canonical migration evidence.

### D2.4 Prototype branches and behavioural comparison

Where policy permits:

* Create isolated prototypes for top candidates.
* Run build/tests.
* Compare dependency graph and security findings.
* Measure bundle/performance where relevant.
* Replay representative inputs against old and new implementation.
* Normalize and compare outputs/errors/side effects.

Do not merge or publish prototypes automatically.

### D2 exit gate

* Recommendations are based on the repository’s used API surface.
* At least two migration paths can be compared through structured evidence.
* Proposed candidates pass license and maintenance gates.
* Prototype failure does not modify the user’s working tree.
* Major migration guidance is relevant to actual usage, not a generic changelog summary.

---

## D3 — Patch, Backport and Upstream Contribution

**Effort:** high
**Value:** high to very high for otherwise unfixable findings

D3 begins only after canonical evidence and safety gates are mature.

### D3.1 Native npm patch support

Detect npm capability/version.

Where supported:

* Use native npm patch functionality.
* Store version-specific unified diffs.
* Record patch hashes in evidence.
* Fail when patches do not apply.
* Verify install, tests and rescan.
* Record patch owner and expiry.

For older npm versions, use only policy-approved fallbacks.

Never treat a manually edited `node_modules` or loose copied `dist` directory as a durable fix.

### D3.2 Fix Transplant Engine

When a fix exists on another maintained branch/version:

1. Locate the upstream fix commit.
2. Identify supporting commits.
3. Compare affected code between source and target lines.
4. Attempt the smallest legal backport.
5. Generate/reuse vulnerability regression tests.
6. Run upstream/package tests where available.
7. Run consumer build/tests.
8. Rescan.
9. Produce a backport-confidence report.

Prefer known upstream fixes over LLM-invented fixes.

### D3.3 Internal fork workflow

Support a governed internal fork using:

* Scoped private package.
* Exact internal version suffix.
* npm override or supported replacement mechanism.
* Original upstream source/version.
* Patch diff.
* CVE.
* SBOM/license.
* Build provenance.
* Owner.
* Review date.
* Upstream issue/advisory.
* Exit/removal condition.

Create a fork-debt ledger. A fork without an owner and expiry is not an accepted remediation.

### D3.4 LLM-assisted candidate patches

LLM may assist with:

* Root-cause explanation.
* Upstream-fix analysis.
* Backport candidate.
* Regression tests.
* Codemods.
* Migration documentation.

LLM output is untrusted.

Required controls:

* Feature flag disabled by default.
* No effect on deterministic Phase A/B/C classification.
* Isolated branch/worktree.
* No credentials provided unnecessarily.
* Full diff shown.
* Vulnerability reproduction required.
* Build/tests/rescan required.
* Human security approval required.
* Outcome labelled `LLM_SYNTHESIZED_PATCH`.
* Never auto-publish.

### D3.5 Licensing gate

Before patching, forking, vendoring or redistributing:

* Detect/package license.
* Check configured organization policy.
* Block unknown or prohibited modification rights.
* Require approval for proprietary/commercial software.
* Record legal basis or approval reference.
* Use `LICENSE_BLOCKED` when modification is not permitted.

GoJS and similar commercial packages must not be modified automatically. Standard GoJS licensing may prohibit modifying libraries/executables unless specific source rights exist.

### D3.6 Upstream disclosure and contribution

The engine may prepare:

* Minimal reproduction.
* Affected versions.
* Root-cause analysis.
* Regression test.
* Patch/backport.
* Issue or pull-request draft.

It must never send externally without explicit approval.

If a vulnerability is not already public:

* Do not open a public issue.
* Prepare private/coordinated disclosure.
* Respect repository security policy.
* Redact customer information.
* Record disclosure status.

### D3 exit gate

* Patch provenance is complete.
* Licensing decision is recorded.
* Patch/backport passes reproduction, build, tests and rescan.
* Internal forks have owners and expiry.
* LLM patches remain human-approved and clearly labelled.
* No public issue, PR or package publication occurs automatically.

---

# 6. Phase 6 and later phases

## Phase 6 — Focused UI Layer

Build only after Phase 5.5 trust gates and preferably Phase 5.6 D1/D2.

The UI must visualize canonical evidence:

* Finding and exposure.
* Recommended path.
* Rejected alternatives.
* Graph/security delta.
* Verification results.
* Policy decision.
* Approval requirement.
* Migration or patch plan.
* Audit history.

Do not build separate decision logic in the UI.

Priorities:

1. VS Code extension.
2. Read-only evidence and analysis.
3. Governed apply/approval workflow.
4. Portfolio/pilot KPI view.

Defer Tauri and Chrome extension until paid-pilot evidence shows demand.

## Phase 7 — Dependency Outcome Knowledge Graph

Begin collecting the event schema now, but build intelligence only after real outcomes exist.

Store:

* Dependency/version.
* Repository/environment.
* Remediation path.
* Build/test results.
* Failures.
* Human decisions.
* PR outcomes.
* Rollbacks.
* Successful migration recipes.
* Patch/fork lifecycle.
* Organization-specific compatibility.

## Phase 8 — Organization-Specific Intelligence

Use verified history for:

* Repository-specific compatibility.
* Reusable remediation recipes.
* Regression-aware recommendations.
* Package-health signals.
* Predictive change risk.
* Cross-repository optimization.

## Phase 9 — LLM Intelligence

Use LLMs for:

* Changelog and migration-guide analysis.
* Relevant breaking-change extraction.
* Root-cause explanation.
* Candidate codemods.
* Backport assistance.
* Natural-language evidence queries.

LLM suggestions must remain subordinate to deterministic evidence, policy and verification.

---

# 7. Implementation sequence for this session

Do not attempt all phases simultaneously.

Execute in this order:

1. Validate current baseline and document material discrepancies.
2. Update roadmap and mission trackers with the complete Phase 5.5/5.6 structure.
3. Mark Phase 5.5 Mission 1 as current.
4. Implement Mission 1 in coherent batches:

   * Secure process and credential boundary.
   * Canonical orchestration and entry-point parity.
   * CI, threat model, tests and documentation reconciliation.
5. Run all Mission 1 exit gates.
6. If Mission 1 passes and sufficient context remains, begin Mission 2.
7. If context is becoming large, stop at an atomic verified state and update `NEXT_MISSION.md` with the exact next implementation unit.
8. Do not begin Phase 5.6 code before Phase 5.5 evidence foundations are complete.

Do not stop after producing a plan unless blocked.

---

# 8. Testing expectations

At minimum preserve and extend:

* Existing full Jest suite.
* Existing Mend regression baseline.
* Existing provider/ecosystem tests.
* Canonical entry-point parity tests.
* Process-injection payload tests.
* Credential-redaction tests.
* Rollback tests.
* Fail-closed evidence tests.
* Evidence-schema validation.
* SARIF/VEX output validation where implemented.
* Policy validation tests.
* Synthetic end-to-end pilot workflow.

Tests should include Windows-aware process behaviour where feasible.

Mock external mutations but retain realistic integration boundaries. Do not claim real scanner, package registry or Git-platform verification when only mocks ran.

---

# 9. Documentation and completion rules

After every code-changing batch:

* Update `docs/SESSION_LOG.md`.
* Update `CODEBASE.md` when files or exports change.
* Update `NEXT_MISSION.md`.
* Update roadmap status only after tests pass.
* Keep completed/pending/blocker states precise.
* Do not create duplicate planning documents.
* Do not mark external pilot execution complete without real approved repositories.
* Do not inflate completion percentages.

At the end, respond concisely with:

1. What was implemented.
2. Security issues closed.
3. Files materially added/changed.
4. Tests run and exact results.
5. Mission exit-gate status.
6. Remaining blockers.
7. Exact next mission.
8. Recommended model/reasoning level for that next mission.

Begin now by reading the minimum source-of-truth files, validating the baseline, updating the roadmap/mission state, and implementing Phase 5.5 Mission 1.
