# Security Architecture — mend-autofixer

**Version:** 1.0  
**Date:** 2026-08-21  

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Entry points                                               │
│  mendfix CLI  │  VS Code extension  │  portfolio-runner     │
└───────────────┴─────────────────────┴──────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  src/providers/   (untrusted input boundary)                │
│  Parse report → LibraryEntry[]                              │
│  9 providers: mend, snyk, npm-audit, dependabot, owasp,     │
│               osv, trivy, gitlab, xray                      │
└────────────────────────┬────────────────────────────────────┘
                         │  LibraryEntry[] (name, version, CVEs)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  src/core/   (zero imports from providers/ or ecosystems/)  │
│  semver-engine.js  → deterministic fix resolution           │
│  phases.js         → A/B/C classification                   │
│  confidence.js     → evidence enrichment                    │
│  remediation-paths.js → path ranking                        │
│  safe-exec.js      → process execution gate                 │
└────────────────────────┬────────────────────────────────────┘
                         │  PhasedItem[]
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  src/ecosystems/   (one module per ecosystem)               │
│  npm / maven / python / go / dotnet / rust                  │
│  writer.js    → write patch files                           │
│  installer.js → spawn package manager via safe-exec.js      │
│  registry.js  → HTTPS version lookups                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Security Properties by Layer

### src/providers/

- **Untrusted input boundary**: all data from report files is treated as untrusted
- Parsers extract: `libraryName` (string), `currentVersion` (string), `recommendedVersion` (string), CVE IDs (string)
- No process spawning; no filesystem writes
- Malformed JSON/Excel causes a thrown error caught by the caller, not a crash that exposes internals
- Provider auto-detection uses structural JSON heuristics, not file extensions or user-supplied strings

### src/core/

- **Zero external dependencies in security-critical path**: phase classification and SemVer resolution use the `semver` package only — no AI, no network, no process spawning
- Core is isolated: `src/core/` has zero imports from `src/providers/` or `src/ecosystems/`
- `safe-exec.js` is the single choke point for all process execution (see below)
- Report generation (`report.js`, `pr-description.js`) produces Markdown strings; no HTML generation; values are string-interpolated without script-capable constructs

### src/ecosystems/

- Each ecosystem writer constructs file patches from `PhasedItem[]` data
- All process spawning routes through `src/core/safe-exec.js`
- Registry lookups use Node 18+ `fetch` (HTTPS); no custom HTTP client; no credential storage

---

## Process Execution Model (`src/core/safe-exec.js`)

All external process spawns in the codebase use `safeSpawn` from `safe-exec.js`. Direct `child_process.spawn` or `exec` calls are prohibited in ecosystem modules.

### Allowlisted executables

Only these executables may be spawned:

```
npm / npm.cmd       mvn / mvn.cmd
pip / pip3          python / python3
go                  cargo
dotnet              git
node / node.exe
```

Any attempt to spawn a non-allowlisted executable throws `Error: executable not in allowlist`.

### Argument validation

Before any spawn, user-derived values pass through validators:

| Validator | Rejects |
|-----------|---------|
| `validatePackageName(name)` | Shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `<`, `>`, `\n`, `\r`), null bytes, empty string |
| `validateVersion(ver)` | Same metacharacter set; enforces semver-like characters only |
| `validatePath(p)` | Null bytes; shell metacharacters in path strings |

### Spawn configuration

- `shell: false` always — no shell interpretation of arguments
- Arguments passed as array (`[exe, ...args]`), never as a concatenated string
- `buildSafeEnv()` returns a minimal environment: `PATH`, `HOME`, `TEMP`/`TMP`, `USERPROFILE`, `SystemRoot` — no inherited secrets

### Windows .cmd resolution

On Windows, `npm` must be invoked as `npm.cmd`. `resolveExecutable(name)` adds `.cmd` suffix on `win32` when the base name is in the allowlist. This prevents bypass via `npm.bat` or similar.

---

## Credential Model

### CLI (mendfix.js)

Tokens for GitHub, GitLab, Azure DevOps, and Bitbucket PR creation are read in priority order:

1. **Environment variable** (preferred): `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_TOKEN`, `BITBUCKET_TOKEN`
2. **CLI argument** (deprecated): `--github-token`, `--gitlab-token`, `--ado-token`, `--bitbucket-token`

When a `--*-token` CLI argument is detected, mendfix emits a deprecation warning to stderr:

```
WARN: --github-token visible in process list. Use GITHUB_TOKEN env var instead.
```

CLI arguments are visible to all users on the system via `ps aux` / `wmic process`. Env vars set for the current process are not.

### VS Code Extension

The extension's `_handleApply` spawns the CLI (`node mendfix.js apply ...`) without any token arguments. The CLI subprocess inherits the VS Code process environment, where `GITHUB_TOKEN` etc. may already be set by the user's shell or VS Code settings.

The extension does **not** pass token arguments to the CLI subprocess. If `--open-pr` is needed from the extension, the user must set the appropriate env var.

The extension's webview runs in a sandboxed iframe with a strict Content Security Policy. No token storage in the webview.

**SecretStorage**: the VS Code SecretStorage API is available in the extension host (not the webview). Future versions of the extension should store tokens in SecretStorage and inject them into the spawned CLI subprocess's environment, not the webview state. This is tracked as a known gap.

### Tokens never appear in

- `remediation-report.md`
- `pr-description.md`
- `manual-review.md`
- `.mend-manifest.json`
- Any process argument passed to package managers
- Any log line printed to stdout/stderr (tokens are only used in provider API calls)

---

## Input Validation Boundaries

| Input | Source | Validation |
|-------|--------|-----------|
| Report file path | CLI `--report` | Caller-supplied; existence checked; JSON.parse inside try/catch |
| Package name (from report) | Provider parser → safe-exec | `validatePackageName` before any process spawn |
| Package version (from report) | Provider parser → safe-exec | `validateVersion` before any process spawn |
| File paths (lock files, pom.xml, etc.) | CLI args | `validatePath` before any process spawn involving the path |
| Portfolio config JSON | `--config` | Parsed with try/catch; required fields checked; no exec of config values |
| npm registry response | HTTPS fetch | JSON.parse inside try/catch; only `versions` array extracted |

Values from vulnerability reports are used only as:
- String comparisons (semver resolution)
- Content of generated markdown files (no execution context)
- CLI arguments to allowlisted executables (after validation)

---

## Output Safety

### Markdown output

Generated markdown (`remediation-report.md`, `pr-description.md`, `manual-review.md`) contains:
- Package names and versions from the report (validated as semver-safe tokens)
- CVE IDs (format: `CVE-YYYY-NNNNN`, `GHSA-*` — safe strings)
- Numeric scores and severity labels

No HTML tags, no JavaScript, no `<script>` blocks are generated. GitHub/GitLab render the output as Markdown, not raw HTML.

**Known gap**: package names are interpolated into Markdown without explicit `escapeMarkdown` treatment. A name like `[evil](javascript:alert(1))` would render as a link in GitHub Markdown. This is tracked as T8 in the threat model.

### JSON output

`phase-a-overrides.json`, `.mend-manifest.json`, and similar files contain package names and version strings only. These are read back by mendfix for idempotency checks — no `eval` or `Function()` is used on their content.

### Credential leakage

`generateReport`, `generatePRDescription`, and all output formatters in `src/core/` accept only `PhasedItem[]` and metadata. No token, credential, or environment variable is passed to these functions.

---

## Registry Response Trust Model

Registry version lookups (`--verify-versions`) are optional. When omitted:
- `registryExists` is `null` on each plan item
- `null` is treated as "don't downgrade phase" — a conservative default
- Phase classification proceeds on report-supplied fix versions only

When `--verify-versions` is set:
- HTTPS fetch to npm/PyPI/Maven Central/etc.
- Response is parsed; only version strings are extracted
- `registryExists === false` escalates an item to Phase C (version not published = no safe fix)
- `registryAdjusted` indicates the nearest available version was substituted

No registry certificate pinning. No integrity verification of registry-returned package manifests. The assumption is that the ecosystem's package manager performs these checks during actual installation.

---

## Known Gaps

| Gap | Risk | Tracking |
|-----|------|---------|
| npm parent-upgrade explorer spawns temp `npm install` with the target repo's `package-lock.json`; lifecycle scripts may execute | Medium — lifecycle scripts in the target repo run in a temp dir with the user's npm config | `--ignore-scripts` partially applied; full enforcement tracked |
| VS Code extension does not use SecretStorage for tokens | Low — tokens currently injected via env var inheritance; no webview exposure | Tracked for Phase 6 extension rebuild |
| Markdown injection (T8) — package names not HTML/Markdown-escaped in generated output | Low — exploitable only if a malicious scanner supplies a crafted package name | Tracked; fix is escaping in `report.js` and `pr-description.js` |
| Portfolio mode does not escalate `registryExists === false` items to Phase C | Low — registry verification is optional; conservative by default | Fix targeted at orchestrator.js canonical pipeline (M1.3) |
