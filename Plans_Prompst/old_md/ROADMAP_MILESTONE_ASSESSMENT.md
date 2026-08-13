Roadmap milestone assessment

What's actually done (major)

┌─────────────────────────────┬───────────────────────┬────────────────────────────────────────────────────────────────────────┐
│            Phase            │        Status         │                             What it means                              │
├─────────────────────────────┼───────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Phase 1 — Mend AutoFixer,   │ ✅ Complete           │ 3-phase classification, SemVer resolution, overrides, pom.xml patches, │
│ npm + Maven                 │                       │  git commits, PR descriptions                                          │
├─────────────────────────────┼───────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Phase 1.x — Remediation     │ ✅ Complete           │ parent-upgrade explorer, override minimizer, graph-diff,               │
│ Path Explorer               │                       │ security-delta, blast radius, confidence scoring                       │
├─────────────────────────────┼───────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Phase 2 — Universal Finding │ ✅ Complete           │ 9 providers: Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy,     │
│  Engine                     │                       │ GitLab, Xray                                                           │
├─────────────────────────────┼───────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Phase 3 — Universal         │ ✅ Complete as of     │ npm, Maven, Python, Go all at write-parity                             │
│ Dependency Engine           │ this session          │                                                                        │
└─────────────────────────────┴───────────────────────┴────────────────────────────────────────────────────────────────────────┘

The roadmap says Phase 3 is "npm + Maven + Python + .NET + Go + Rust". You have 4/6 ecosystems. .NET (NuGet) and Rust (Cargo) would complete Phase 3 fully.

What's next (major only)

Complete Phase 3: Add .NET (src/ecosystems/dotnet/) and Rust (src/ecosystems/rust/). Same 5-file pattern. NuGet registry is api.nuget.org; Cargo registry is crates.io. Rust uses Cargo.lock (TOML), .NET uses packages.lock.json.

Phase 4 — CI/CD Platform integration: GitLab already parsed as a provider. The write-back side (opening MRs, posting comments) is the gap. GitHub is partially covered by renovate-apply.js. GitLab, Azure DevOps, Bitbucket are unstarted.

Phase 5 — Remediation Orchestration: Much of this is already built (override minimizer, security delta, blast radius). The gap is portfolio-level: running across multiple repos in one pass, tracking remediation outcomes over time.

Skip for now: Phases 6-9 (Knowledge Graph, Intelligence, LLM). These are explicitly deferred until the deterministic layer is mature — exactly as the roadmap says.

Immediate next recommendation: .NET + Rust to close Phase 3, then a --multi-repo mode for Phase 5 entry.