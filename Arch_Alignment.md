
Architecture alignment

Yes — your diagram maps exactly to the current codebase. Here's the precise mapping:


Your diagram                     →   Code
─────────────────────────────────────────────────────────────────
Mend / Snyk / Dependabot             src/providers/*.js
OSV / Trivy / GitLab / Xray          (GitLab + Xray = remaining gap)
          ↓
Canonical Finding Model          →   LibraryEntry[] interface
                                     (src/providers/index.js contract)
          ↓
Dependency Graph Engine          →   src/ecosystems/npm/lock-parser.js
                                     src/ecosystems/maven/dep-tree.js
          ↓
Remediation Engine               →   src/core/semver-engine.js  → ResolutionItem[]
                                     src/core/phases.js          → PhasedItem[]
                                     src/core/remediation-paths.js
          ↓
npm / Maven / Python / Go        →   src/ecosystems/npm/   ✅
                                     src/ecosystems/maven/ ✅
                                     Python / Go           ❌ not yet
          ↓
Simulate + Verify                →   src/ecosystems/npm/simulator.js
                                     src/ecosystems/npm/override-minimizer.js
                                     src/ecosystems/npm/installer.js

Two genuine gaps vs your diagram:

┌─────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│       Gap       │                                               What it means                                                │
├─────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ GitLab + Xray   │ Two more src/providers/*.js files — same pattern as the 7 already done                                     │
│ providers       │                                                                                                            │
├─────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Python / Go     │ Need src/ecosystems/python/ and src/ecosystems/go/ — the writers, lock parsers, and registry checkers.     │
│ ecosystems      │ Trivy already emits PYTHON_PACKAGE and GO_MODULE libraryTypes so the data path is ready; only the writers  │
│                 │ are missing                                                                                                │
└─────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────┘


The LibraryEntry[] as Canonical Finding Model is the key architectural insight — every provider normalizes to that shape before the engine sees anything. The engine never imports from providers. That's the isolation rule that makes your diagram real.

7 providers now shipped: Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy



**********

What "adding Python/Go" actually means

Adding a Python ecosystem is not just writing a lock file parser. It requires all of these to be at parity:

src/ecosystems/python/
  lock-parser.js    — poetry.lock, Pipfile.lock, requirements.txt pin parser
  writer.js         — write version pins to pyproject.toml / requirements.txt
  registry.js       — PyPI version check (pypi.org/pypi/{name}/json)
  installer.js      — pip install + verify in venv
  simulator.js      — isolated pip install in temp venv

The same for Go:
src/ecosystems/go/
  lock-parser.js    — go.sum / go.mod parser → DepTree
  writer.js         — go.mod replace directives
  registry.js       — proxy.golang.org version check
  installer.js      — go mod tidy + verify
  simulator.js      — go mod download in temp GOPATH

The core stays untouched. detectEcosystem() just needs new return values ('python', 'go'), and the CLI apply path gets new branches. Everything in src/core/ runs as-is.


┌───────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│                     Question                      │                                  Answer                                  │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does the canonical model work for all ecosystems? │ ✅ Yes — providers normalize everything to LibraryEntry[]                │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does the remediation classification (Phase A/B/C) │ ✅ Yes — src/core/ is ecosystem-agnostic                                 │
│  work for all?                                    │                                                                          │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does Maven work today?                            │ ⚠️ ~70% — writing + registry work, but no simulation, no parent-chain    │
│                                                   │ explorer, no graph-diff                                                  │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Will Python/Go work automatically when added?     │ ❌ No — each needs its own ecosystem writer, lock parser, registry, and  │
│                                                   │ simulator                                                                │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Is the architecture the right one for             │ ✅ Yes — the isolation is correct. You add ecosystems like plugins,      │
│ multi-ecosystem?                                  │ never touching core                                                      │
└───────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────┘






Architecture alignment — what's truly universal vs what's npm-biased

Your diagram is structurally correct. But "will it work seamlessly" depends on which layer you're talking about. Here's the exact truth:

Layer 1 — Providers → Canonical Finding Model ✅ Universal now

Every provider emits LibraryEntry[]. The engine never sees provider-specific code. This works for all 9 providers regardless of ecosystem. This layer is done and universal.

---
Layer 2 — Remediation Engine (core/) ✅ Universal

semver-engine.js, phases.js, confidence.js, remediation-paths.js, report.js — all operate on LibraryEntry[] → ResolutionItem[] → PhasedItem[]. Zero ecosystem imports. Semver is used across npm, Maven, Python (PEP 440 is close enough with coerce), Go (uses semver natively since Go 1.11). Phase A/B/C classification works identically for all ecosystems today.

---
Layer 3 — Dependency Graph Engine ⚠️ Partial

┌───────────┬────────────────────────────────────────────────────────────┬───────────────────────────────────────────┐
│ Ecosystem │                        What exists                         │              What's missing               │
├───────────┼────────────────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ npm       │ lock-parser.js — full DepTree, blast radius, parent chains │ Nothing                                   │
├───────────┼────────────────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ Maven     │ dep-tree.js — runs mvn dependency:tree, parses output      │ No parent-chain explorer, no blast radius │
├───────────┼────────────────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ Python    │ ❌ Nothing                                                 │ poetry.lock/Pipfile.lock parser needed    │
├───────────┼────────────────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ Go        │ ❌ Nothing                                                 │ go.sum parser needed                      │
└───────────┴────────────────────────────────────────────────────────────┴───────────────────────────────────────────┘

This directly affects Phase classification quality. Without a lock-file DepTree, Phase B detection (multi-version conflicts, consumer range validation) can't run — everything defaults to Phase A or C based on SemVer alone, which is less accurate.

---
Layer 4 — Ecosystem Writers ⚠️ npm-first, Maven partial

┌───────────────┬────────────────────────┬──────────────────────────┬───────────────────────────────────┬────────────────────┐
│    Feature    │          npm           │          Maven           │              Python               │         Go         │
├───────────────┼────────────────────────┼──────────────────────────┼───────────────────────────────────┼────────────────────┤
│               │ overrides.js —         │ pom-writer.js —          │ ❌ needs                          │ ❌ needs go.mod    │
│ Patch writing │ package.json overrides │ <dependencyManagement>   │ requirements.txt/pyproject.toml   │ replace writer     │
│               │                        │                          │ writer                            │                    │
├───────────────┼────────────────────────┼──────────────────────────┼───────────────────────────────────┼────────────────────┤
│ Registry      │ ✅ npm registry        │ ✅ Maven Central         │ ❌ needs PyPI                     │ ❌ needs           │
│ check         │                        │                          │                                   │ proxy.golang.org   │
├───────────────┼────────────────────────┼──────────────────────────┼───────────────────────────────────┼────────────────────┤
│ Direct dep    │ ✅ applyDirectUpgrades │ ❌ not wired             │ ❌                                │ ❌                 │
│ bumps         │                        │                          │                                   │                    │
├───────────────┼────────────────────────┼──────────────────────────┼───────────────────────────────────┼────────────────────┤
│ Parent-chain  │ ✅ full recursive      │ ❌                       │ ❌                                │ ❌                 │
│ explorer      │                        │                          │                                   │                    │
└───────────────┴────────────────────────┴──────────────────────────┴───────────────────────────────────┴────────────────────┘

---
Layer 5 — Simulate + Verify ❌ npm-only today

This is the most npm-biased layer and the hardest to generalize:

┌───────────┬─────────────────────────────────────────────┬───────────────────────────────────────────────┐
│ Ecosystem │             Simulate mechanism              │                 Current state                 │
├───────────┼─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ npm       │ npm install --package-lock-only in temp dir │ ✅ Full — simulator.js, override-minimizer.js │
├───────────┼─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Maven     │ mvn dependency:resolve in temp dir          │ ❌ Not implemented (slow; needs network)      │
├───────────┼─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Python    │ pip install --dry-run or venv in temp dir   │ ❌ Not implemented                            │
├───────────┼─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Go        │ go mod tidy in temp dir                     │ ❌ Not implemented                            │
└───────────┴─────────────────────────────────────────────┴───────────────────────────────────────────────┘

---
What "adding Python/Go" actually means

Adding a Python ecosystem is not just writing a lock file parser. It requires all of these to be at parity:

src/ecosystems/python/
  lock-parser.js    — poetry.lock, Pipfile.lock, requirements.txt pin parser
  writer.js         — write version pins to pyproject.toml / requirements.txt
  registry.js       — PyPI version check (pypi.org/pypi/{name}/json)
  installer.js      — pip install + verify in venv
  simulator.js      — isolated pip install in temp venv

The same for Go:
src/ecosystems/go/
  lock-parser.js    — go.sum / go.mod parser → DepTree
  writer.js         — go.mod replace directives
  registry.js       — proxy.golang.org version check
  installer.js      — go mod tidy + verify
  simulator.js      — go mod download in temp GOPATH

The core stays untouched. detectEcosystem() just needs new return values ('python', 'go'), and the CLI apply path gets new branches. Everything in src/core/ runs as-is.

---
Bottom line

┌───────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│                     Question                      │                                  Answer                                  │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does the canonical model work for all ecosystems? │ ✅ Yes — providers normalize everything to LibraryEntry[]                │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does the remediation classification (Phase A/B/C) │ ✅ Yes — src/core/ is ecosystem-agnostic                                 │
│  work for all?                                    │                                                                          │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Does Maven work today?                            │ ⚠️ ~70% — writing + registry work, but no simulation, no parent-chain    │
│                                                   │ explorer, no graph-diff                                                  │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Will Python/Go work automatically when added?     │ ❌ No — each needs its own ecosystem writer, lock parser, registry, and  │
│                                                   │ simulator                                                                │
├───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Is the architecture the right one for             │ ✅ Yes — the isolation is correct. You add ecosystems like plugins,      │
│ multi-ecosystem?                                  │ never touching core                                                      │
└───────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────┘