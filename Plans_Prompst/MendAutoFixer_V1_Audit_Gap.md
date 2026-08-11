# Mend Auto Fixer — V1 Completion Audit & Gap Plan

## CONTEXT

This project started as a Mend vulnerability remediation tool and has evolved into a more general dependency remediation engine.

The current implementation has already been developed substantially. It now includes:

* Mend finding ingestion
* npm dependency analysis
* `package-lock.json` parsing
* dependency graph information
* SemVer analysis
* Phase A / B / C classification
* overrides
* nested overrides
* consumer-range validation
* dev/build dependency signals
* Maven support
* provider/ecosystem abstractions
* remediation reporting
* Renovate PR processing across repositories

The documentation has also been cleaned up separately. **Do not assume old documentation represents the current architecture. Treat the actual source code as authoritative and inspect the current repository structure first.**

We are now at a **V1 completion checkpoint**.

### IMPORTANT

Do NOT start implementing fixes yet.

Your task in this phase is:

1. Inspect the entire repository.
2. Understand the actual implementation.
3. Validate it against the requirements and scenarios below.
4. Identify every gap, inconsistency, incomplete implementation, incorrect assumption, missing test, and potentially unsafe behavior.
5. Create a detailed implementation plan for the remaining work.
6. Include your own findings in addition to the requirements below.
7. STOP after producing the plan.

Do not implement code during this task.

Do not introduce LLM/AI functionality.

Do not start Dependency Intelligence Engine work.

Do not add additional ecosystems unless required to validate the architecture.

Do not refactor working code merely for stylistic reasons.

---

# 1. PRIMARY OBJECTIVE

The objective of V1 is:

> Given vulnerability findings and a target repository, deterministically analyze the actual dependency graph, identify the safest remediation path, generate the remediation plan, optionally apply it, verify the resulting dependency state, and produce an auditable report.

The engine must not blindly trust:

* Mend recommendations
* SemVer compatibility
* vulnerability severity
* Renovate PRs
* package metadata

It must inspect the actual dependency structure whenever the required information is available.

---

# 2. CURRENT ARCHITECTURAL DIRECTION

The architecture should remain capable of separating:

```text
Finding Provider
        ↓
Canonical Finding
        ↓
Ecosystem Adapter
        ↓
Dependency Graph
        ↓
Deterministic Remediation Engine
        ↓
Remediation Plan
        ↓
Validation
        ↓
Report
        ↓
Optional Apply / PR Operations
```

Examples:

### Finding providers

* Mend
* Renovate
* future Snyk
* future Dependabot
* future Trivy
* future OSV
* etc.

### Ecosystems

* npm
* Maven
* future Python
* future .NET
* future Go
* future Rust
* etc.

Do not assume provider and ecosystem are the same thing.

For example:

```text
Mend + npm
Mend + Maven
Renovate + npm
Renovate + Maven
```

must conceptually be possible.

---

# 3. REQUIRED V1 AUDIT

For each item below determine:

* IMPLEMENTED
* PARTIALLY IMPLEMENTED
* MISSING
* INCORRECT
* NOT TESTED

For every non-complete item identify:

* exact file(s)
* relevant function(s)
* current behavior
* expected behavior
* gap
* risk
* recommended implementation
* tests required

Do not give vague statements such as "improve dependency handling."

Be precise enough that another developer can implement the fix without interpreting the requirement differently.

---

# 4. FINDING INGESTION

Validate:

### Mend

* Mend JSON input
* Mend Excel input, if currently supported
* multiple findings
* duplicate findings
* duplicate CVEs affecting the same package
* multiple fixed versions
* missing fixed version
* no-fix findings
* malformed findings
* unknown fields

### Provider abstraction

Verify that remediation logic does not unnecessarily depend on Mend-specific structures.

The core engine should operate on a canonical finding representation.

### Required test

The same logical finding should produce the same remediation decision regardless of whether it originated from a supported provider.

---

# 5. DEPENDENCY GRAPH

Validate the dependency graph against actual package-manager data.

## npm

Test:

### Simple

```text
A
└── B
```

### Shared

```text
A ──→ C
B ──→ C
```

### Deep

```text
A
└── B
    └── C
        └── D
```

### Multiple versions

```text
A
└── brace-expansion@1.x

B
└── brace-expansion@2.x
```

### Scoped package

```text
@scope/package
```

### Exact dependency

```json
"foo": "6.4.2"
```

### Caret

```json
"foo": "^6.4.2"
```

### Tilde

```json
"foo": "~6.4.2"
```

### Optional dependencies

### Peer dependencies

### Dev dependencies

### Production dependencies

### Missing package entries

### Invalid/corrupt lockfile

### npm lockfile v2

### npm lockfile v3

Confirm that parent/child relationships are reconstructed correctly.

Do not infer relationships merely from package names when the lockfile provides path/version information.

---

# 6. MAVEN

Validate that Maven support is genuinely integrated into the same conceptual engine rather than being a parallel implementation that duplicates core remediation logic.

Test:

* direct dependency
* transitive dependency
* multiple versions
* dependencyManagement
* exclusions
* version overrides
* parent POM relationships
* dependency tree extraction
* fixed version determination
* unresolved dependency
* missing metadata
* no-fix finding

Identify what is truly implemented versus what is only represented by the architecture.

Do not claim Maven support is complete merely because Maven files can be parsed.

---

# 7. SEMVER / VERSION COMPATIBILITY

Validate every important version scenario.

## Safe range

```text
consumer: ^6.4.2
current: 6.4.5
fix: 6.5.7
```

Expected:

```text
fix satisfies consumer range
```

## Exact pin

```text
consumer: 6.4.2
fix: 6.5.7
```

Expected:

```text
fix does NOT satisfy consumer range
```

## Tilde

```text
~6.4.2
```

## Cross-major

```text
^6.x → 7.x
```

## Multiple ranges

```text
>=6.4.0 <7.0.0
```

## Pre-release

Validate if supported.

The engine must not classify a recommendation as "safe" solely because the versions look similar.

---

# 8. PHASE CLASSIFICATION

Validate the meaning of each phase.

## Phase A

Should represent:

> Deterministically compatible remediation that can be considered safe for automated application based on available dependency metadata.

Do NOT represent Phase A as "guaranteed safe."

SemVer compatibility is not proof that application behavior cannot regress.

Verify that Phase A requires all necessary consumer-range checks when a dependency graph is available.

---

## Phase B

Should represent cases such as:

* parent upgrade required
* exact consumer pin
* potentially breaking but technically possible override
* nested override
* remediation requiring validation
* dependency graph indicates a safer remediation path than direct override

---

## Phase C

Should represent cases such as:

* no fixed version
* incompatible major
* insufficient dependency information
* unresolved parent relationship
* remediation cannot safely be automated
* manual investigation required

Every finding must end in exactly one classification.

---

# 9. CONSUMER RANGE VALIDATION

For every vulnerable package:

1. Find every relevant consumer.
2. Determine its declared dependency range.
3. Check whether the recommended/fixed version satisfies that range.
4. Identify exact pins.
5. Identify incompatible ranges.
6. Produce an explanation.

Example:

```text
Consumer: package-x
Declared: =6.4.2
Recommended: 6.5.7
Result: incompatible
Decision: parent upgrade/manual remediation
```

Important:

Do not merely inspect the root `package.json`.

The lockfile dependency graph must be used.

---

# 10. MULTIPLE-VERSION / MULTI-MAJOR HANDLING

Example:

```text
brace-expansion@1.x
brace-expansion@2.x
```

Validate that the engine can determine:

```text
which parent consumes 1.x
which parent consumes 2.x
what each parent declares
what remediation is required for each branch
```

Nested overrides must be generated only when the dependency graph provides enough evidence.

Example concept:

```json
{
  "glob": {
    "brace-expansion": "1.1.18"
  },
  "minimatch": {
    "brace-expansion": "2.0.1"
  }
}
```

But this must NOT automatically be considered safe merely because the nested override syntax is valid.

The resulting lockfile must be validated.

If the graph is ambiguous, stay in Phase C/manual review.

---

# 11. OVERRIDE LIFECYCLE

This is a critical part of the actual manual workflow and must be fully represented.

Expected process:

```text
Candidate fix
      ↓
Temporary override
      ↓
npm install --package-lock-only
      ↓
Inspect resulting lockfile
      ↓
Is target version actually resolved?
      ↓
Yes
      ↓
Remove override
      ↓
npm install --package-lock-only again
      ↓
Does target version remain?
      ↓
Yes → override unnecessary
No → retain override
```

Validate:

* temporary override
* permanent override
* nested override
* existing overrides
* override merging
* override removal
* lockfile-only installation
* resulting dependency resolution
* failure during npm installation
* rollback behavior

Do not mark an override unnecessary based only on static SemVer analysis if an actual package-manager simulation can verify it.

---

# 12. PARENT UPGRADE ANALYSIS

The engine must support the actual manual investigation process.

Example:

```text
vulnerable package
       ↑
parent A
       ↑
parent B
       ↑
root package
```

For each level:

1. Identify parent.
2. Identify its declared dependency range.
3. Determine whether a newer parent version exists.
4. Determine whether that parent update can remove the vulnerable dependency/version.
5. Continue upward when necessary.
6. Prefer upgrading a maintained parent over forcing a child override when appropriate.

Do not limit this capability to finding root parents.

Distinguish:

```text
root parent
direct consumer
transitive consumer
upgrade candidate
```

---

# 13. FALSE POSITIVE / BUILD-ONLY ANALYSIS

Validate these categories:

* runtime dependency
* production dependency
* development dependency
* build dependency
* test dependency
* lint dependency
* Storybook dependency
* bundler dependency
* CLI dependency
* mixed runtime/dev chain
* unknown

The `dev: true` lockfile flag is a signal, not proof of a false positive.

Minimum V1 behavior:

```text
probableFalsePositive = true
```

only when the available evidence supports it.

Do not automatically suppress or close a security finding solely because `dev === true`.

Generate evidence such as:

```text
All known dependency entries are development-only.
Confirm production reachability before treating as false positive.
```

The report should clearly distinguish:

```text
Probable False Positive
```

from:

```text
Confirmed False Positive
```

unless the engine has sufficient evidence to make the stronger determination.

---

# 14. REACHABILITY

Validate whether the vulnerable package can be reached through:

* production dependency chain
* development dependency chain
* build chain
* test chain
* mixed chain

Example:

```text
A → B → vulnerable
C → D → vulnerable
```

If A is production and C is dev-only:

Expected:

```text
Not false positive
```

because at least one production path exists.

This scenario must have an automated regression test.

---

# 15. REPORTING

Every finding should have an auditable decision containing, where available:

```text
Finding
Package
Current version
Fixed version
Severity
Provider
Ecosystem
Dependency paths
Consumers
Decision
Phase
Reason
Evidence
Recommended action
Override
Parent upgrade
False-positive signal
Confidence
```

Do not generate recommendations without explanations.

---

# 16. RENOVATE PR WORKFLOW

A new capability has been added:

> Process Renovate PRs across a supplied set of repositories using the same remediation engine.

Treat this as an important V1/V1.x capability and audit it separately.

Expected workflow:

```text
Repositories
      ↓
Find Renovate PRs
      ↓
Read PR metadata
      ↓
Identify dependency change
      ↓
Run same remediation engine
      ↓
Analyze repository dependency graph
      ↓
Generate remediation report
      ↓
Apply remediation where appropriate
      ↓
Run validation/tests
      ↓
Optionally close Renovate PR
```

IMPORTANT:

The Renovate workflow must NOT implement a second dependency-analysis engine.

It must invoke the same core remediation engine used by Mend.

---

# 17. RENOVATE PR SCENARIOS

Test:

### One repository / one PR

Expected normal processing.

### One repository / many PRs

Example:

```text
20 Renovate PRs
```

The engine should be able to inspect them consistently.

### Multiple repositories

```text
repo A
repo B
repo C
```

Each must have isolated dependency state.

### PR with safe update

Engine should recognize whether the Renovate change is compatible with the dependency graph.

### PR with breaking update

Must not blindly apply.

### PR that fixes a vulnerability

Must correlate with the finding when possible.

### PR that does not relate to a vulnerability

Must not be incorrectly classified as a security remediation.

### Duplicate Renovate PRs

Must handle safely.

### Closed/merged PR

Should not be reprocessed unless explicitly requested.

### PR already applied manually

Detect current repository state before applying.

### Multiple Renovate PRs affecting related dependencies

This is important.

Example:

```text
PR A → parent package
PR B → child package
```

The engine should identify whether applying both independently is necessary.

### Conflicting Renovate PRs

Do not blindly combine them.

### Failed patch/application

Repository must remain recoverable.

### Optional close behavior

The close-PR operation must be explicitly controlled.

Default should be:

```text
analyze/apply
```

not:

```text
automatically close PR
```

unless the user explicitly enables it.

---

# 18. RENOVATE CONSOLIDATION

Validate the higher-level use case:

```text
10–20 Renovate PRs
        ↓
Analyze all
        ↓
Determine compatible updates
        ↓
Apply compatible changes
        ↓
Resolve required dependency changes
        ↓
Run validation
        ↓
Produce one consolidated remediation result
```

The engine must NOT assume that all Renovate PRs can safely be merged into one change.

It must classify:

```text
Safe to consolidate
Independent
Conflicting
Requires manual review
Already covered by another update
```

---

# 19. GIT SAFETY

Any automatic repository modification must have safeguards.

Validate:

* clean/dirty working tree
* branch creation
* current branch
* uncommitted user changes
* rollback
* patch failure
* merge conflict
* package-manager failure
* test failure
* network failure
* repository access failure

Never destroy unrelated user changes.

---

# 20. TESTING

Create a permanent test fixture suite.

At minimum:

```text
tests/
├── providers/
├── core/
├── ecosystems/
│   ├── npm/
│   └── maven/
├── renovate/
├── fixtures/
└── integration/
```

Required fixture scenarios include:

* semver-safe update
* exact pin
* tilde
* cross-major
* multiple versions
* nested dependency
* shared dependency
* dev-only dependency
* mixed runtime/dev chains
* no fix
* parent upgrade
* flat override
* nested override
* removable override
* required override
* malformed lockfile
* missing dependency
* Maven transitive dependency
* Maven dependencyManagement
* Renovate single PR
* Renovate multiple PRs
* Renovate multiple repositories
* Renovate conflict
* Renovate failed application

---

# 21. IDEMPOTENCY

Run the same operation twice.

Expected:

```text
First run:
changes made

Second run:
no unnecessary changes
```

This is especially important for:

* overrides
* lockfiles
* Renovate processing
* reports
* repository modifications

---

# 22. DRY RUN

Every destructive operation should support dry-run where practical.

Dry-run must show:

```text
WHAT WOULD CHANGE
WHY
WHICH FILE
WHICH PACKAGE
WHICH VERSION
WHICH PR
WHETHER PR WOULD BE CLOSED
```

No repository modification should happen during dry-run.

---

# 23. ERROR / RECOVERY MODEL

For every operation identify:

```text
Input failure
Analysis failure
Dependency-resolution failure
Patch failure
Test failure
Git failure
PR failure
```

The tool should produce a useful failure state rather than silently continuing.

One repository failing must not corrupt processing of other repositories.

---

# 24. PERFORMANCE / SCALE

Evaluate:

* 1 repository
* 10 repositories
* 100 repositories
* large lockfiles
* hundreds of findings
* many Renovate PRs

Identify unnecessary repeated work.

Especially consider whether the dependency graph is rebuilt unnecessarily for every finding/PR.

A repository graph should be reusable within a processing run where safe.

---

# 25. SECURITY / SAFETY

Audit:

* command execution
* repository paths
* package names
* version strings
* PR titles
* branch names
* generated override content
* shell arguments
* untrusted report data

Do not allow finding/PR/package metadata to become unsafe shell commands.

---

# 26. ARCHITECTURE QUALITY

Verify that the following responsibilities are separated:

```text
Provider
Finding normalization
Ecosystem adapter
Dependency graph
Version analysis
Remediation decision
Override generation
Package-manager execution
Git operations
PR operations
Reporting
```

Do not allow:

```text
Mend-specific logic
```

to leak throughout the core engine.

Do not allow:

```text
npm-specific assumptions
```

inside generic remediation logic.

Do not duplicate remediation logic for Renovate.

---

# 27. DOCUMENTATION CONSISTENCY

The current repository documentation has recently been cleaned up.

Review the CURRENT documentation against the CURRENT implementation.

Do not recreate or add multiple competing roadmap documents.

There must be one authoritative explanation for:

* current product scope
* architecture
* current implementation status
* next development phase

If multiple documents conflict, report the conflict and recommend which should become authoritative.

Do not rewrite documentation during this audit unless explicitly requested.

---

# 28. IMPORTANT PRODUCT BOUNDARY

V1 is NOT:

* an LLM system
* a learning engine
* an autonomous AI agent
* a dependency knowledge graph platform
* a predictive compatibility engine
* an enterprise intelligence platform

Those are future phases.

V1 is:

> A deterministic dependency remediation engine that can understand actual dependency relationships and safely automate repetitive remediation work.

---

# 29. FUTURE ARCHITECTURE CHECK

Although future features must NOT be implemented now, confirm that today's architecture does not prevent them.

Future direction:

```text
Providers
Mend
Renovate
Snyk
Dependabot
Trivy
OSV
etc.

        ↓

Canonical Finding Model

        ↓

Ecosystem Adapters
npm
Maven
Python
.NET
Go
Rust
etc.

        ↓

Universal Dependency Graph

        ↓

Deterministic Remediation Engine

        ↓

Repository / CI / PR Integration

        ↓

Historical Remediation Knowledge

        ↓

Dependency Intelligence

        ↓

LLM / AI Assistance
```

Do not implement these future layers.

Only identify architectural blockers that would make them difficult later.

---

# 30. REQUIRED OUTPUT FROM THIS TASK

Produce ONE detailed document:

`V1_COMPLETION_AUDIT.md`

It must contain:

## A. Executive summary

Current maturity and major risks.

## B. Implemented capabilities

Only claim something is implemented if the code demonstrates it.

## C. Partial capabilities

What exists but is incomplete.

## D. Missing capabilities

Requirements not implemented.

## E. Incorrect behavior

Anything that can produce an unsafe or misleading recommendation.

## F. Test coverage gaps

Every missing scenario.

## G. Renovate workflow audit

Separate detailed assessment.

## H. Architecture gaps

Anything preventing the next universal phase.

## I. Documentation gaps

Only actual inconsistencies.

## J. Prioritized backlog

Use:

```text
P0 — Must fix before V1 completion
P1 — Required for V1 quality
P2 — Important but can follow V1
P3 — Future
```

## K. Implementation plan

For every P0/P1 item provide:

```text
Problem
Current implementation
Expected behavior
Files affected
Implementation approach
Test cases
Acceptance criteria
Dependencies
Risk
```

## L. Final V1 checklist

A checkbox list that can be used to declare V1 complete.

---

# 31. CRITICAL RULE

Do not simply confirm that the existing implementation satisfies the above.

Act as a skeptical reviewer.

Look for:

* hidden assumptions
* unsafe automation
* false confidence
* missing edge cases
* incomplete error handling
* duplicated logic
* architecture leakage
* missing tests
* inconsistent provider behavior
* inconsistent ecosystem behavior
* Renovate-specific bugs
* idempotency problems
* rollback problems

If something is ambiguous, mark it as:

```text
REQUIRES DECISION
```

rather than guessing.

After creating `V1_COMPLETION_AUDIT.md`, STOP.

Do not modify source code until the audit and plan are reviewed.
