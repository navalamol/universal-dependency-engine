#!/usr/bin/env node
'use strict';

if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Error: Node.js 18 or higher is required (running ${process.versions.node})`);
  process.exit(1);
}

const fs   = require('fs');
const path = require('path');
const semver = require('semver');

const { detectProvider, getParser, PROVIDER_NAMES }      = require('./src/providers/index');

function parseReport(reportPath, providerOverride) {
  const provider = providerOverride || detectProvider(reportPath);
  return getParser(provider).parseReport(reportPath);
}
const { buildResolutionPlan }                            = require('./src/core/semver-engine');
const { applyPhases, PHASE_META }                        = require('./src/core/phases');
const { verifyPlanVersions: verifyNpm }                  = require('./src/ecosystems/npm/registry');
const { verifyPlanVersions: verifyMaven }                = require('./src/ecosystems/maven/registry');
const { buildPhaseAOverrides, buildPhaseBOverrides, buildParentUpgradeMap,
        applyOverridesToPackageJson, writeOverridesPatch,
        detectDirectDeps, applyDirectUpgrades }            = require('./src/ecosystems/npm/overrides');
const { exploreParentUpgrades }                          = require('./src/ecosystems/npm/parent-upgrade-explorer');
const { snapshotFiles, restoreFiles, runPackageLockUpdate, runMavenResolve,
        verifyFixVersions, saveManifest,
        detectManualChanges }                              = require('./src/ecosystems/npm/installer');
const { writePomPatch, applyPomPatch,
        detectManualChanges: detectMavenChanges }          = require('./src/ecosystems/maven/pom-writer');
const { generateReport }                                 = require('./src/core/report');
const { generatePRDescription }                          = require('./src/core/pr-description');
const { enrichWithConfidence }                           = require('./src/core/confidence');
const { enrichWithPaths }                                = require('./src/core/remediation-paths');
const { parseLockFile, getRootDeps, findDepChain }       = require('./src/ecosystems/npm/lock-parser');
const { captureGraph, diffGraphs, formatDiff }           = require('./src/core/graph-diff');
const { minimizeOverrides }                              = require('./src/ecosystems/npm/override-minimizer');
const { detectEcosystem }                                = require('./src/ecosystems/index');

// ---------------------------------------------------------------------------
// CLI arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key  = arg.slice(2);
    const next = argv[i + 1];
    args[key]  = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return args;
}

function printUsage() {
  console.log(`
Usage:
  mendfix analyze   --report <path> [options]          (dry run — no files changed)
  mendfix apply     --report <path> [options]          (apply Phase A + optionally Phase B, write output)
  mendfix cleanup   --package-json <path> --lock-file <path>   (remove stale overrides)
  mendfix renovate  --config <repos.json> [options]    (analyze/apply Renovate PRs across repos)
  mendfix portfolio --config <portfolio.json> [options] (analyze vulnerabilities across multiple repos)

  # Legacy flag-based syntax still works:
  node mendfix.js --report <path> [--dry-run] [--package-json <path>] ...

Required (analyze / apply):
  --report <path>            Vulnerability report (.json or .xlsx)
  --provider <name>          Force provider parser (auto-detected when omitted)
                             Supported: mend, snyk, npm-audit, dependabot, owasp

Options:
  --package-json <path>      (npm) Apply overrides/direct upgrades directly to this file
  --apply-phase-b            (npm) Also apply Phase B overrides + parent bumps (default: Phase A only)
  --pom-xml <path>           (maven) Apply Phase A <dependencyManagement> entries to this file
  --lock-file <path>         (npm) package-lock.json for dep-tree features
                             Enables: consumer range validation, dev classification,
                             parent upgrade recommendations
  --requirements-txt <path>  (python) Apply Phase A pins directly to this requirements file
  --go-mod <path>            (go) Apply Phase A replace directives to this go.mod
  --packages-props <path>    (dotnet) Apply Phase A pins to Directory.Packages.props or .csproj
  --cargo-toml <path>        (rust) Apply Phase A pins to Cargo.toml
  --ecosystem <npm|maven|python|go|dotnet|rust>  Override auto-detected ecosystem
  --out-dir <path>           Output directory  [default: ./mend-output]
  --verify-versions          Check registry to confirm versions exist
  --dry-run                  Print plan to stdout; write nothing to disk
  --commit                   (apply only) Auto-commit Phase A fixes after successful install
                             Phase B/C commits are opt-in after human review
  --commit-phase-b           (apply only) Auto-commit Phase B fixes (requires --apply-phase-b)
  --verbose                  Print Safety Gate pre-edit checklist for every item
  --force                    Override Safety Gate halts (MANUAL confidence, MAJOR_BUMP paths,
                             peer conflicts). Use only after manual review.
  --max-depth <n>            Max recursion depth for parent-chain exploration  [default: 5]
  --max-simulations <n>      Max npm install simulations per run               [default: 20]
  --simulate                 (cleanup only) Use simulation to verify override removal
                             instead of static lockfile analysis. Slower but exact.

Phase output files written to --out-dir:
  npm:    phase-a-overrides.json / phase-b-overrides.json / manual-review.md
  maven:  phase-a-pom-patch.xml / phase-b-pom-patch.xml / manual-review.md
  python: phase-a-requirements.txt / phase-b-requirements.txt / manual-review.md
  go:     phase-a-go-mod.txt / phase-b-go-mod.txt / manual-review.md
  dotnet: phase-a-packages-props.xml / phase-b-packages-props.xml / manual-review.md
  rust:   phase-a-cargo-toml.txt / phase-b-cargo-toml.txt / manual-review.md
          remediation-report.md  (all ecosystems)

Examples:
  mendfix analyze  --report vuln-report.json
  mendfix analyze  --report vuln-report.json --verify-versions
  mendfix apply    --report npm-report.json \\
    --package-json ../ui-platform/package.json \\
    --lock-file    ../ui-platform/package-lock.json \\
    --verify-versions --commit
  mendfix apply    --report npm-report.json \\
    --package-json ../ui-platform/package.json \\
    --lock-file    ../ui-platform/package-lock.json \\
    --apply-phase-b --verify-versions --commit --commit-phase-b
  mendfix apply    --report maven-report.json \\
    --pom-xml ../dataplatform/pom.xml \\
    --verify-versions
  mendfix cleanup  --package-json ../ui-platform/package.json \\
    --lock-file ../ui-platform/package-lock.json [--simulate]

Open PR/MR after apply (Phase 4):
  --open-pr                  Create a PR/MR on the CI/CD platform after apply
  --platform <name>          Platform: github, gitlab, azuredevops, bitbucket
  --pr-branch <branch>       Source branch (defaults to current git branch)
  --pr-base <branch>         Target/base branch for the PR  [default: main]
  --pr-title <title>         PR title (auto-generated from CVE summary when omitted)
  --pr-draft                 Create as draft PR (GitHub only)

  GitHub:
  --github-token <token>     GitHub token (or GITHUB_TOKEN env var)
  --github-owner <owner>     GitHub org or user
  --github-repo <repo>       GitHub repository name

  GitLab:
  --gitlab-token <token>     GitLab token (or GITLAB_TOKEN env var)
  --gitlab-project-id <id>   Project numeric ID or namespace/path
  --gitlab-base-url <url>    Base URL for self-hosted GitLab  [default: https://gitlab.com]

  Azure DevOps:
  --ado-token <token>        PAT with Code (Read & Write) scope (or AZURE_DEVOPS_TOKEN)
  --ado-org <org>            Azure DevOps organisation
  --ado-project <project>    Team project name or GUID
  --ado-repo-id <id>         Repository name or GUID

  Bitbucket:
  --bitbucket-token <token>  "username:app_password" or repository access token (or BITBUCKET_TOKEN)
  --bitbucket-workspace <ws> Workspace slug
  --bitbucket-repo-slug <slug> Repository slug

Note: the source branch must be pushed to the remote before --open-pr will succeed.

Portfolio mode (Phase 5):
  mendfix portfolio --config <portfolio.json> [--out-dir <path>] [--verify-versions] [--dry-run]

  portfolio.json schema:
  {
    "repos": [
      {
        "name": "org/repo",          // display name (required)
        "report": "./report.json",   // path to vulnerability report (required)
        "ecosystem": "npm",          // optional — auto-detected when omitted
        "provider": "snyk",          // optional — auto-detected when omitted
        "lockFile": "./package-lock.json",  // optional (npm only)
        "verifyVersions": true       // optional — per-repo override
      }
    ],
    "outDir": "./portfolio-output",  // optional
    "verifyVersions": false          // optional global default
  }
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noun(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function detectJsonIndent(raw) {
  const m = raw.match(/^[{[]\r?\n([ \t]+)/);
  if (!m) return 2;
  const ws = m[1];
  return ws[0] === '\t' ? '\t' : ws.length;
}

function writeJson(filePath, raw, obj) {
  const indent = detectJsonIndent(raw);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, indent) + '\n');
}

function printPhaseRow(tag, phase, items) {
  const meta = PHASE_META[phase];
  console.log(`  ${tag} Phase ${phase} (${meta.confidence}): ${noun(items.length, 'library', 'libraries')} — ${meta.label}`);
}

// ---------------------------------------------------------------------------
// Safety Gate pre-edit checklist (Item 8 — REMEDIATION_CAPABILITY_ROADMAP §6)
// ---------------------------------------------------------------------------

/**
 * Format the pre-edit safety checklist for one PhasedItem.
 * Printed at --verbose level; halts apply when confidence is MANUAL, path has MAJOR_BUMP,
 * or peer conflicts detected — unless --force is passed.
 */
function assembleSafetyGate(item) {
  const rp    = item.recommendedPath;
  const cves  = (item.cves || []).map(c => `${c.id} (${c.severity} ${c.score})`).join(', ');
  const chain = item.depChain && item.depChain.length > 1 ? item.depChain.join(' → ') : item.libraryName;

  const rows = [
    `Finding:          ${cves || '(see report)'}`,
    `Dependency path:  ${chain}`,
    `Current:          ${item.libraryName}@${item.currentVersion}`,
    `Fixed:            ${item.libraryName}@${item.recommendedVersion || 'N/A'}`,
  ];

  if (rp) {
    if (rp.type === 'PARENT_UPGRADE' && rp.detail) {
      rows.push(`Parent range:     ${rp.detail.parent} declares ${item.libraryName}@${rp.detail.childDeclaredRange || '?'}`);
      rows.push(`Parent candidate: ${rp.detail.parent}@${rp.detail.parentUpgradeVersion} (within ${rp.detail.parentAllowedRange})`);
      rows.push(`Simulation:       ${rp.detail.simulationVerified ? 'VERIFIED' : 'INFERRED (not simulated)'}`);
    }
    const peerInfo = rp.peerConflicts && rp.peerConflicts.length
      ? `CONFLICTS: ${rp.peerConflicts.join(', ')}`
      : 'none detected';
    rows.push(`Runtime class:    ${item.probableFalsePositive ? 'DEV-ONLY' : 'RUNTIME'}`);
    rows.push(`Decision:         ${item.decisionLabel || '?'}`);
    rows.push(`Confidence:       ${rp.confidence}`);
    rows.push(`Budget tier:      ${rp.budgetLabel}`);
    rows.push(`Risk:             ${item.upgradeType}; peer dep conflicts: ${peerInfo}`);
    if (rp.securityDelta) {
      rows.push(`Security delta:   fixed=${rp.securityDelta.fixed.length} introduced=${rp.securityDelta.introduced.length}`);
    }
  } else {
    rows.push(`Decision:         ${item.decisionLabel || 'MANUAL_SECURITY_REVIEW'}`);
    rows.push(`Confidence:       MANUAL`);
  }

  return rows.map(r => `    ${r}`).join('\n');
}

/**
 * Returns true (= should halt apply) when the item requires human confirmation.
 * The caller should skip the item or exit unless --force is set.
 */
function shouldHaltForSafetyGate(item) {
  const rp = item.recommendedPath;
  if (!rp) return true; // no path = MANUAL
  if (rp.confidence === 'MANUAL') return true;
  if (item.upgradeType === 'MAJOR_BUMP' && rp.type !== 'PARENT_UPGRADE') return true;
  if (rp.peerConflicts && rp.peerConflicts.length > 0) return true;
  if (rp.securityDelta && rp.securityDelta.introduced.length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Idempotency check (Scenario 21)
// Returns true if the plan is already applied (manifest matches current plan).
// ---------------------------------------------------------------------------

function isAlreadyApplied(packageJsonPath, phaseAOverrides, directUpgrades) {
  const manifestPath = path.join(path.dirname(packageJsonPath), '.mend-manifest.json');
  if (!fs.existsSync(manifestPath)) return false;

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return false; }

  const directMap = {};
  for (const u of directUpgrades) directMap[u.libraryName] = u.recommendedVersion;

  const overridesSame = JSON.stringify(phaseAOverrides) === JSON.stringify(manifest.overrides || {});
  const directSame    = JSON.stringify(directMap)       === JSON.stringify(manifest.directUpgrades || {});

  return overridesSame && directSame;
}

// ---------------------------------------------------------------------------
// Cleanup mode (standalone post-install override removal, npm only)
// ---------------------------------------------------------------------------

async function runCleanup(lockFilePath, packageJsonPath, opts = {}) {
  console.log('\nMend AutoFixer — Cleanup');
  console.log('========================');

  if (!packageJsonPath) {
    console.error('ERROR: --package-json <path> is required in cleanup mode');
    process.exit(1);
  }
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`ERROR: ${packageJsonPath} not found`);
    process.exit(1);
  }

  const rawPkg = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(rawPkg);
  const overrides = pkg.overrides || {};
  const overrideEntries = Object.entries(overrides).filter(([, v]) => typeof v === 'string');

  if (overrideEntries.length === 0) {
    console.log('\nNo flat string overrides found in package.json — nothing to check.');
    return;
  }

  // Item 13 — simulation-based override minimization
  if (opts.simulate) {
    if (!lockFilePath || !fs.existsSync(lockFilePath)) {
      console.error('ERROR: --lock-file <path> is required for --simulate mode');
      process.exit(1);
    }
    console.log(`\nLock file: ${lockFilePath}`);
    console.log(`Simulating removal of ${overrideEntries.length} override(s) via npm install...\n`);
    console.log('(Each simulation runs npm install in a temp dir — may take a few seconds per override)\n');

    const result = minimizeOverrides(packageJsonPath, lockFilePath, {
      maxSimulations: opts.maxSimulations,
      dryRun: false,
    });

    if (result.removed.length > 0) {
      console.log(`  ✅ Removed (simulation confirmed unnecessary):`);
      for (const name of result.removed) console.log(`     ${name}`);
    }
    if (result.kept.length > 0) {
      console.log(`  🔒 Kept (still needed or simulation inconclusive):`);
      for (const name of result.kept) console.log(`     ${name}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ℹ  Skipped (nested overrides — manual review required):`);
      for (const name of result.skipped) console.log(`     ${name}`);
    }
    if (result.limitHit) {
      console.log(`\n  ⚠  Simulation limit reached — some overrides were not tested. Pass --max-simulations <n> to increase.`);
    }
    if (result.removed.length === 0) {
      console.log('\nNo overrides could be safely removed by simulation.');
    } else {
      console.log(`\n${result.removed.length} override(s) removed from ${packageJsonPath}`);
      console.log('Next: npm install --package-lock-only --legacy-peer-deps');
    }
    return;
  }

  let depMap;
  try {
    depMap = parseLockFile(lockFilePath);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nLock file: ${lockFilePath}`);
  console.log(`Checking ${overrideEntries.length} override(s)...\n`);

  const toRemove = [];

  for (const [pkgName, overrideVersion] of overrideEntries) {
    const entries = depMap.get(pkgName) || [];

    if (entries.length === 0) {
      console.log(`  🗑  ${pkgName}: not found in lock file — override is stale (package removed)`);
      toRemove.push(pkgName);
      continue;
    }

    const allEffective = entries.every(e =>
      semver.valid(e.resolvedVersion) &&
      semver.valid(overrideVersion) &&
      semver.gte(e.resolvedVersion, overrideVersion)
    );

    if (!allEffective) {
      const resolved = entries.map(e => e.resolvedVersion).join(', ');
      console.log(`  ❌ ${pkgName}@${overrideVersion}: NOT effective (lock resolved to: ${resolved})`);
      continue;
    }

    const allParentsCover = entries.every(entry =>
      entry.parents.length === 0 ||
      entry.parents.every(p => {
        try { return semver.satisfies(overrideVersion, p.range); } catch { return false; }
      })
    );

    const resolved = entries.map(e => e.resolvedVersion).join(', ');
    if (allParentsCover) {
      console.log(`  🟡 ${pkgName}@${overrideVersion}: in effect (resolved: ${resolved}) — all consumer ranges cover fix; likely removable`);
      toRemove.push(pkgName);
    } else {
      console.log(`  ✅ ${pkgName}@${overrideVersion}: in effect (resolved: ${resolved}) — needed (pinned consumer)`);
    }
  }

  const nestedCount = Object.entries(overrides).filter(([, v]) => typeof v !== 'string').length;
  if (nestedCount > 0) {
    console.log(`\n  ℹ  ${nestedCount} nested override(s) skipped — not handled in cleanup mode`);
  }

  if (toRemove.length === 0) {
    console.log('\nAll overrides appear needed. Nothing removed.');
    return;
  }

  console.log(`\n${toRemove.length} removable override(s): ${toRemove.join(', ')}`);

  for (const name of toRemove) {
    delete pkg.overrides[name];
  }
  if (Object.keys(pkg.overrides).length === 0) {
    delete pkg.overrides;
  }

  writeJson(packageJsonPath, rawPkg, pkg);
  console.log(`Removed from ${packageJsonPath}`);
  console.log('\nNext: npm install --package-lock-only --legacy-peer-deps');
  console.log('If vulnerable versions reappear, restore the removed override(s).');
}

// ---------------------------------------------------------------------------
// Portfolio mode (Phase 5)
// ---------------------------------------------------------------------------

async function runPortfolioCommand(argv) {
  const args     = parseArgs(argv);
  const cfgPath  = args.config || null;
  const outDir   = args['out-dir'] || null;
  const dryRun   = args['dry-run'] === true;
  const verify   = args['verify-versions'] === true;

  if (!cfgPath) {
    console.error('ERROR: mendfix portfolio requires --config <portfolio.json>');
    process.exit(1);
  }

  console.log('\nMend AutoFixer [PORTFOLIO]');
  console.log('==========================');
  console.log(`Config : ${cfgPath}`);
  if (outDir)  console.log(`Out dir: ${outDir}`);
  if (verify)  console.log('Registry verification: enabled');
  if (dryRun)  console.log('Dry run: no files written');

  const { runPortfolio }                 = require('./portfolio-runner');
  const { generatePortfolioReport,
          writePortfolioReport }         = require('./src/core/portfolio-report');
  const { generateReport }              = require('./src/core/report');

  let portfolio;
  try {
    portfolio = await runPortfolio(cfgPath, { outDir, verifyVersions: verify });
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }

  // Console summary
  console.log(`\nRepos scanned : ${portfolio.totalRepos}`);
  console.log(`Total CVEs    : ${portfolio.totalCves}`);
  console.log(`Libraries     : ${portfolio.totalLibraries}`);
  console.log(`\n  ✅ Phase A (auto-apply)  : ${portfolio.totalPhaseA}`);
  console.log(`  ⚠️  Phase B (review first) : ${portfolio.totalPhaseB}`);
  console.log(`  ❌ Phase C (manual review): ${portfolio.totalPhaseC}`);
  if (portfolio.errorCount > 0) {
    console.log(`\n  ⚠  ${portfolio.errorCount} repo(s) failed — see error details in portfolio-report.md`);
  }

  if (dryRun) {
    console.log('\n' + '─'.repeat(70));
    console.log(generatePortfolioReport(portfolio));
    return;
  }

  // Write per-repo remediation reports
  for (const repo of portfolio.repos) {
    if (repo.status === 'error') continue;
    const phasedPlan = [...repo.phaseA, ...repo.phaseB, ...repo.phaseC];
    if (phasedPlan.length === 0) continue;

    try {
      fs.mkdirSync(repo.outDir, { recursive: true });
      const reportContent = generateReport(phasedPlan, {
        project:    repo.name,
        reportDate: portfolio.runDate,
        ecosystem:  repo.ecosystem,
      });
      const rptPath = path.join(repo.outDir, 'remediation-report.md');
      fs.writeFileSync(rptPath, reportContent);
      console.log(`\n  [${repo.name}] Phase A:${repo.phaseA.length} B:${repo.phaseB.length} C:${repo.phaseC.length} — ${rptPath}`);
    } catch (err) {
      console.warn(`  WARN: could not write report for ${repo.name}: ${err.message}`);
    }
  }

  // Write portfolio report
  const portfolioReportPath = writePortfolioReport(portfolio, portfolio.outDir);
  console.log(`\nPortfolio report: ${portfolioReportPath}`);
  console.log('\nDone.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── Subcommand routing ───────────────────────────────────────────────────
  const rawArgs = process.argv.slice(2);
  const SUBCMDS = ['analyze', 'apply', 'cleanup', 'renovate', 'portfolio'];
  const subcmd  = SUBCMDS.includes(rawArgs[0]) ? rawArgs.shift() : null;

  if (subcmd === 'renovate') {
    const { main: renovateMain } = require('./renovate-apply');
    await renovateMain(rawArgs);
    return;
  }

  if (subcmd === 'portfolio') {
    await runPortfolioCommand(rawArgs);
    return;
  }

  const args    = parseArgs(rawArgs);

  if (subcmd === 'analyze') args['dry-run'] = true;
  if (subcmd === 'cleanup') {
    // cleanup: --lock-file becomes the positional verify-overrides arg
    const lf = args['lock-file'];
    if (!lf) {
      console.error('ERROR: mendfix cleanup requires --lock-file <path>');
      process.exit(1);
    }
    await runCleanup(lf, args['package-json'] || null, { simulate: !!args.simulate, maxSimulations: args['max-simulations'] ? parseInt(args['max-simulations'], 10) : undefined });
    return;
  }

  // Legacy standalone verify-overrides mode (backward compat)
  if (args['verify-overrides'] && !args.report) {
    await runCleanup(args['verify-overrides'], args['package-json'] || null);
    return;
  }

  if (!args.report || args.help) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  // M1.2 — Credential deprecation warning: tokens passed as CLI args appear in
  // the process list (ps aux / Task Manager) and shell history. Env vars are safe.
  {
    const TOKEN_ENV = {
      'github-token':    'GITHUB_TOKEN',
      'gitlab-token':    'GITLAB_TOKEN',
      'ado-token':       'AZURE_DEVOPS_TOKEN',
      'bitbucket-token': 'BITBUCKET_TOKEN',
    };
    for (const [arg, envName] of Object.entries(TOKEN_ENV)) {
      if (args[arg]) {
        process.stderr.write(
          `WARN: --${arg} exposes credentials in the process list. ` +
          `Use the ${envName} environment variable instead.\n`
        );
      }
    }
  }

  const reportFile      = args.report;
  const providerFlag    = args['provider'] || null;
  const packageJsonPath    = args['package-json'] || null;
  const pomXmlPath         = args['pom-xml'] || null;
  const lockFilePath       = args['lock-file'] || null;
  const requirementsTxtPath = args['requirements-txt'] || null;
  const goModPath          = args['go-mod'] || null;
  const packagesPropsPath  = args['packages-props'] || null;
  const cargoTomlPath      = args['cargo-toml'] || null;
  const outDir          = args['out-dir'] || path.join(path.dirname(path.resolve(reportFile)), 'mend-output');
  const verifyVersions  = args['verify-versions'] === true;
  const dryRun          = args['dry-run'] === true;
  const autoCommit      = args['commit'] === true;
  const autoCommitPhaseB = args['commit-phase-b'] === true;
  const applyPhaseB     = args['apply-phase-b'] === true;
  const verbose         = args['verbose'] === true;
  const forceApply      = args['force']   === true;
  const maxDepth        = args['max-depth']       ? parseInt(args['max-depth'], 10)       : undefined;
  const maxSimulations  = args['max-simulations'] ? parseInt(args['max-simulations'], 10) : undefined;

  if (providerFlag && !PROVIDER_NAMES.includes(providerFlag)) {
    console.error(`ERROR: Unknown --provider "${providerFlag}". Valid values: ${PROVIDER_NAMES.join(', ')}`);
    process.exit(1);
  }

  const mode = subcmd ? subcmd.toUpperCase() : (dryRun ? 'ANALYZE' : 'APPLY');
  console.log(`\nMend AutoFixer [${mode}]`);
  console.log('='.repeat(16 + mode.length));
  console.log(`Report  : ${reportFile}`);
  if (providerFlag) console.log(`Provider: ${providerFlag} (forced)`);
  if (packageJsonPath)     console.log(`Target  : ${packageJsonPath}`);
  if (pomXmlPath)          console.log(`POM     : ${pomXmlPath}`);
  if (lockFilePath)        console.log(`Lock    : ${lockFilePath}`);
  if (requirementsTxtPath) console.log(`Reqs    : ${requirementsTxtPath}`);
  if (goModPath)           console.log(`go.mod  : ${goModPath}`);
  if (packagesPropsPath)   console.log(`Props   : ${packagesPropsPath}`);
  if (cargoTomlPath)       console.log(`Cargo   : ${cargoTomlPath}`);
  if (!dryRun)         console.log(`Out dir : ${outDir}`);

  // ── Step 1: Parse report ─────────────────────────────────────────────────
  console.log('\n[1/5] Parsing vulnerability report...');
  let entries;
  try {
    entries = parseReport(reportFile, providerFlag);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }

  const totalCves = entries.reduce((n, e) => n + e.cves.length, 0);
  console.log(`  ${noun(entries.length, 'unique library', 'unique libraries')} with vulnerabilities`);
  console.log(`  ${totalCves} total CVEs`);

  const ecosystem = detectEcosystem(entries, args.ecosystem);
  console.log(`  Ecosystem: ${ecosystem}`);
  if (verifyVersions) {
    const registryName = { maven: 'Maven Central', python: 'PyPI', go: 'Go module proxy', dotnet: 'NuGet', rust: 'crates.io' }[ecosystem] || 'npm';
    console.log(`  Registry: ${registryName} verification enabled`);
  }

  // ── Step 1.5: Parse lock file (npm only) ─────────────────────────────────
  let depTree  = null;
  let rootDeps = null;

  if (ecosystem === 'npm') {
    if (lockFilePath) {
      console.log('\n[1.5/5] Parsing package-lock.json...');
      try {
        depTree  = parseLockFile(lockFilePath);
        rootDeps = getRootDeps(lockFilePath);
        console.log(`  ${depTree.size} unique packages in dependency tree`);
      } catch (err) {
        console.warn(`  WARN: ${err.message} — dep-tree features disabled`);
      }
    } else {
      console.log('\n[1.5/5] Skipping lock file (pass --lock-file to enable dep-tree features)');
    }
  } else if (ecosystem === 'maven') {
    const mavenProjectDir = pomXmlPath ? path.dirname(pomXmlPath) : null;
    if (mavenProjectDir) {
      console.log('\n[1.5/5] Building Maven dependency tree...');
      const { buildMavenDepTree } = require('./src/ecosystems/maven/dep-tree');
      depTree = buildMavenDepTree(mavenProjectDir);
      if (depTree) {
        console.log(`  ${depTree.size} unique artifacts in Maven dependency tree`);
      } else {
        console.log('  Maven dep-tree unavailable — dep-tree enrichments disabled');
      }
    } else {
      console.log('\n[1.5/5] Skipping Maven dep-tree (pass --pom-xml to enable)');
    }
  } else if (ecosystem === 'python') {
    const { parseLockFile: parsePyLock, detectLockFile } = require('./src/ecosystems/python/lock-parser');
    const lockCandidate = requirementsTxtPath ||
      (goModPath ? null : detectLockFile(path.dirname(path.resolve(reportFile))));
    if (lockCandidate && fs.existsSync(lockCandidate)) {
      console.log('\n[1.5/5] Parsing Python lock file...');
      try {
        depTree = parsePyLock(lockCandidate);
        console.log(`  ${depTree.size} unique packages in Python dependency tree`);
      } catch (err) {
        console.warn(`  WARN: ${err.message} — dep-tree features disabled`);
      }
    } else {
      console.log('\n[1.5/5] Skipping Python lock file (pass --requirements-txt to enable)');
    }
  } else if (ecosystem === 'go') {
    const lockCandidate = goModPath || null;
    if (lockCandidate && fs.existsSync(lockCandidate)) {
      console.log('\n[1.5/5] Parsing go.mod...');
      try {
        const { parseLockFile: parseGoLock } = require('./src/ecosystems/go/lock-parser');
        depTree = parseGoLock(lockCandidate);
        console.log(`  ${depTree.size} unique modules in Go dependency tree`);
      } catch (err) {
        console.warn(`  WARN: ${err.message} — dep-tree features disabled`);
      }
    } else {
      console.log('\n[1.5/5] Skipping go.mod parsing (pass --go-mod to enable)');
    }
  } else if (ecosystem === 'dotnet') {
    const { parseLockFile: parseDotnetLock, detectLockFile: detectDotnetLock } = require('./src/ecosystems/dotnet/lock-parser');
    const lockCandidate = packagesPropsPath ||
      detectDotnetLock(path.dirname(path.resolve(reportFile)));
    if (lockCandidate && fs.existsSync(lockCandidate)) {
      console.log('\n[1.5/5] Parsing .NET dependency file...');
      try {
        depTree = parseDotnetLock(lockCandidate);
        console.log(`  ${depTree.size} unique packages in .NET dependency tree`);
      } catch (err) {
        console.warn(`  WARN: ${err.message} — dep-tree features disabled`);
      }
    } else {
      console.log('\n[1.5/5] Skipping .NET lock file (pass --packages-props to enable)');
    }
  } else if (ecosystem === 'rust') {
    const cargoLockPath = cargoTomlPath
      ? path.join(path.dirname(cargoTomlPath), 'Cargo.lock')
      : null;
    const lockCandidate = cargoLockPath && fs.existsSync(cargoLockPath) ? cargoLockPath
      : cargoTomlPath && fs.existsSync(cargoTomlPath) ? cargoTomlPath
      : null;
    if (lockCandidate) {
      console.log('\n[1.5/5] Parsing Cargo.lock...');
      try {
        const { parseLockFile: parseRustLock } = require('./src/ecosystems/rust/lock-parser');
        depTree = parseRustLock(lockCandidate);
        console.log(`  ${depTree.size} unique crates in Rust dependency tree`);
      } catch (err) {
        console.warn(`  WARN: ${err.message} — dep-tree features disabled`);
      }
    } else {
      console.log('\n[1.5/5] Skipping Cargo.lock parsing (pass --cargo-toml to enable)');
    }
  }

  // ── Step 2: Resolve fix versions ─────────────────────────────────────────
  console.log('\n[2/5] Resolving fix versions (SemVer)...');
  let plan = buildResolutionPlan(entries);

  // ── Step 3: Optional registry verification ───────────────────────────────
  if (verifyVersions) {
    if (ecosystem === 'maven') {
      console.log('\n[3/5] Verifying versions against Maven Central...');
      plan = await verifyMaven(plan);
    } else if (ecosystem === 'python') {
      console.log('\n[3/5] Verifying versions against PyPI...');
      const { verifyPlanVersions: verifyPyPI } = require('./src/ecosystems/python/registry');
      plan = await verifyPyPI(plan);
    } else if (ecosystem === 'go') {
      console.log('\n[3/5] Verifying versions against Go module proxy...');
      const { verifyPlanVersions: verifyGo } = require('./src/ecosystems/go/registry');
      plan = await verifyGo(plan);
    } else if (ecosystem === 'dotnet') {
      console.log('\n[3/5] Verifying versions against NuGet...');
      const { verifyPlanVersions: verifyNuget } = require('./src/ecosystems/dotnet/registry');
      plan = await verifyNuget(plan);
    } else if (ecosystem === 'rust') {
      console.log('\n[3/5] Verifying versions against crates.io...');
      const { verifyPlanVersions: verifyCrates } = require('./src/ecosystems/rust/registry');
      plan = await verifyCrates(plan);
    } else {
      console.log('\n[3/5] Verifying versions against npm registry...');
      plan = await verifyNpm(plan);
    }

    for (const item of plan) {
      if (item.registryExists === false && item.phase !== 'C') {
        const regName = { maven: 'Maven Central', python: 'PyPI', go: 'Go module proxy', dotnet: 'NuGet', rust: 'crates.io' }[ecosystem] || 'npm';
        console.log(`  ⚠  ${item.libraryName}: ${item.recommendedVersion} not found on ${regName} — escalating to Phase C`);
        item.phase         = 'C';
        item.justification = `Recommended version ${item.recommendedVersion} is not published. No verified fix available in the ${semver.major(item.currentVersion)}.x range.`;
      }
      if (item.registryAdjusted) {
        console.log(`  ~  ${item.libraryName}: adjusted ${item.registryRequested} → ${item.recommendedVersion} (nearest available)`);
      }
    }
  } else {
    console.log('\n[3/5] Skipping registry check (pass --verify-versions to enable)');
  }

  // ── Step 4: Apply phase classification ───────────────────────────────────
  console.log('\n[4/5] Classifying by phase...');
  let phasedPlan = applyPhases(plan, depTree, rootDeps);

  if (depTree && rootDeps) {
    const allRootDeps = { ...rootDeps.dependencies, ...rootDeps.devDependencies };
    for (const item of phasedPlan) {
      if (item.phase !== 'C') continue;
      if (item.upgradeType === 'MAJOR_BUMP') {
        const entries = depTree.get(item.libraryName) || [];
        const allParents = new Set(entries.flatMap(e => e.parents.map(p => p.name)));
        item.rootParents = [...allParents]
          .filter(name => allRootDeps[name])
          .map(name => ({
            name,
            range: allRootDeps[name],
            isDev: !!rootDeps.devDependencies[name],
          }));
      }
      item.depChain = findDepChain(item.libraryName, depTree, rootDeps);

      // For indirect chains (root dep → intermediate(s) → vulnerable child),
      // add the chain root to rootParents with chainVia so the explorer can
      // walk the intermediate hops via the registry.
      if (
        item.upgradeType === 'MAJOR_BUMP' &&
        item.depChain && item.depChain.length >= 3
      ) {
        const chainRoot = item.depChain[0];
        if (allRootDeps[chainRoot] && !(item.rootParents || []).find(p => p.name === chainRoot)) {
          if (!item.rootParents) item.rootParents = [];
          item.rootParents.push({
            name:     chainRoot,
            range:    allRootDeps[chainRoot],
            isDev:    !!rootDeps.devDependencies[chainRoot],
            chainVia: item.depChain.slice(1, -1), // intermediate packages between root and vulnerable child
          });
        }
      }
    }

    // Parent upgrade exploration — npm only; Python/Go do not have the same
    // transitive dependency graph model and the explorer is npm-specific.
    if (verifyVersions && ecosystem === 'npm') {
      console.log('\n[4b/5] Exploring parent upgrade paths...');
      await exploreParentUpgrades(phasedPlan, 'npm', packageJsonPath, lockFilePath,
        { maxDepth, maxSimulations });
    }
  }

  phasedPlan = enrichWithConfidence(phasedPlan, depTree);
  phasedPlan = enrichWithPaths(phasedPlan, entries);

  const phaseA = phasedPlan.filter(r => r.phase === 'A');
  const phaseB = phasedPlan.filter(r => r.phase === 'B');
  const phaseC = phasedPlan.filter(r => r.phase === 'C');

  printPhaseRow('✅', 'A', phaseA);
  printPhaseRow('⚠️ ', 'B', phaseB);
  printPhaseRow('❌', 'C', phaseC);

  console.log('');
  for (const r of phaseA) console.log(`  ✅ ${r.libraryName}: ${r.currentVersion} → ${r.recommendedVersion}`);
  for (const r of phaseB) {
    if (r.parentUpgradePaths) {
      const parents = r.parentUpgradePaths.map(p => `${p.parent}@${p.parentUpgradeVersion}`).join(', ');
      console.log(`  ⚠️  ${r.libraryName}: upgrade ${parents} → fixes transitively  [PARENT_UPGRADE]`);
    } else {
      console.log(`  ⚠️  ${r.libraryName}: ${r.currentVersion} → ${r.recommendedVersion}`);
    }
  }
  for (const r of phaseC) {
    const fix = r.recommendedVersion || 'NO FIX';
    const fp  = r.probableFalsePositive ? ' [PROBABLE FALSE POSITIVE]' : '';
    console.log(`  ❌ ${r.libraryName}: ${r.currentVersion} → ${fix}  [${r.upgradeType}]${fp}`);
  }

  // ── Safety Gate (Item 8) ────────────────────────────────────────────────
  // Print pre-edit checklist at --verbose; halt apply for MANUAL/MAJOR/peer-conflict
  // items unless --force is set.
  if (!dryRun) {
    const haltItems = [];
    if (verbose) console.log('\n[Safety Gate]');
    for (const item of phasedPlan) {
      // Phase C items go to manual-review.md — never auto-applied, never a halt trigger.
      if (item.phase === 'C') continue;
      if (verbose) {
        console.log(`\n  ${item.libraryName}:`);
        console.log(assembleSafetyGate(item));
      }
      if (shouldHaltForSafetyGate(item) && !forceApply) {
        haltItems.push(item);
      }
    }
    if (haltItems.length > 0) {
      console.log('\n⛔ Safety Gate halted apply for the following items (use --force to override):');
      for (const item of haltItems) {
        const reason = !item.recommendedPath ? 'no viable path'
          : item.recommendedPath.confidence === 'MANUAL' ? 'MANUAL confidence'
          : item.upgradeType === 'MAJOR_BUMP' ? 'MAJOR_BUMP without verified parent upgrade'
          : item.recommendedPath.peerConflicts && item.recommendedPath.peerConflicts.length ? 'peer conflicts detected'
          : 'new vulnerabilities introduced by candidate';
        console.log(`  ❌ ${item.libraryName}: ${reason}`);
        if (!verbose) console.log(assembleSafetyGate(item));
      }
      console.log('\nRun with --force to apply anyway, or address the flagged items first.');
      process.exitCode = 1;
      return;
    }
  }

  // ── Step 5: Write output ─────────────────────────────────────────────────
  console.log('\n[5/5] Writing output...');

  const reportOpts = {
    project:        path.basename(reportFile, path.extname(reportFile)),
    reportDate:     new Date().toISOString().split('T')[0],
    verifyVersions,
    ecosystem,
  };

  if (dryRun) {
    console.log('\n' + '─'.repeat(70));
    console.log(generateReport(phasedPlan, reportOpts));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  let applyFailed;
  if (ecosystem === 'maven') {
    applyFailed = await writeOutputMaven(phasedPlan, phaseA, phaseB, phaseC, outDir, pomXmlPath, generateReport(phasedPlan, reportOpts));
  } else if (ecosystem === 'python') {
    applyFailed = await writeOutputPython(phasedPlan, phaseA, phaseB, phaseC, outDir, requirementsTxtPath, generateReport(phasedPlan, reportOpts));
  } else if (ecosystem === 'go') {
    applyFailed = await writeOutputGo(phasedPlan, phaseA, phaseB, phaseC, outDir, goModPath, generateReport(phasedPlan, reportOpts));
  } else if (ecosystem === 'dotnet') {
    applyFailed = await writeOutputDotnet(phasedPlan, phaseA, phaseB, phaseC, outDir, packagesPropsPath, generateReport(phasedPlan, reportOpts));
  } else if (ecosystem === 'rust') {
    applyFailed = await writeOutputRust(phasedPlan, phaseA, phaseB, phaseC, outDir, cargoTomlPath, generateReport(phasedPlan, reportOpts));
  } else {
    // Pass reportOpts so writeOutputNpm can regenerate with directDeps info after the split
    applyFailed = await writeOutputNpm(phasedPlan, phaseA, phaseB, phaseC, outDir, packageJsonPath, depTree, reportOpts, verifyVersions, applyPhaseB);
  }

  if (applyFailed) {
    console.log('\nApply failed — see errors above. No changes were made.');
    return;
  }

  // Scenario 18: write PR description
  const prDescPath = path.join(outDir, 'pr-description.md');
  const prDescMeta = {
    project:     path.basename(reportFile, path.extname(reportFile)),
    reportDate:  new Date().toISOString().split('T')[0],
    ecosystem,
  };
  fs.writeFileSync(prDescPath, generatePRDescription(phasedPlan, prDescMeta));
  console.log(`  Wrote: ${prDescPath}`);

  // Phase 4: open PR/MR on CI/CD platform when --open-pr is set.
  if (args['open-pr']) {
    const { openPR, buildPRTitle, getCurrentBranch } = require('./src/core/pr-poster');

    const platformArg = args['platform'] || null;
    const tokenByPlatform = {
      github:      args['github-token']    || process.env.GITHUB_TOKEN,
      gitlab:      args['gitlab-token']    || process.env.GITLAB_TOKEN,
      azuredevops: args['ado-token']       || process.env.AZURE_DEVOPS_TOKEN,
      bitbucket:   args['bitbucket-token'] || process.env.BITBUCKET_TOKEN,
    };

    const prToken      = platformArg ? (tokenByPlatform[platformArg] || null) : null;
    const sourceBranch = args['pr-branch'] || getCurrentBranch();
    const prTitle      = args['pr-title'] || buildPRTitle(phasedPlan, ecosystem);
    const prBody       = fs.readFileSync(prDescPath, 'utf8');

    const prConfig = {
      platform:           platformArg,
      token:              prToken,
      sourceBranch,
      targetBranch:       args['pr-base'] || 'main',
      title:              prTitle,
      body:               prBody,
      draft:              !!args['pr-draft'],
      githubOwner:        args['github-owner']          || null,
      githubRepo:         args['github-repo']           || null,
      gitlabProjectId:    args['gitlab-project-id']     || null,
      gitlabBaseUrl:      args['gitlab-base-url']       || null,
      adoOrg:             args['ado-org']               || null,
      adoProject:         args['ado-project']           || null,
      adoRepoId:          args['ado-repo-id']           || null,
      bitbucketWorkspace: args['bitbucket-workspace']   || null,
      bitbucketRepoSlug:  args['bitbucket-repo-slug']   || null,
    };

    console.log(`\nOpening ${platformArg === 'gitlab' ? 'MR' : 'PR'} on ${platformArg || '(no platform set)'}...`);
    const prResult = await openPR(prConfig);
    if (prResult.ok) {
      console.log(`  Created: ${prResult.url}`);
    } else {
      console.warn(`  WARN: PR/MR creation failed: ${prResult.error}`);
      console.warn(`  PR description saved to: ${prDescPath} — create the PR manually.`);
    }
  }

  // Scenarios 15/16: auto-commit Phase A after successful apply.
  // Phase B commit is opt-in via --commit-phase-b (requires --apply-phase-b).
  if (autoCommit && phaseA.length > 0) {
    const { commitPhaseA } = require('./src/core/git-commits');
    const projectDir = packageJsonPath ? path.dirname(packageJsonPath)
      : pomXmlPath          ? path.dirname(pomXmlPath)
      : requirementsTxtPath ? path.dirname(requirementsTxtPath)
      : goModPath           ? path.dirname(goModPath)
      : packagesPropsPath   ? path.dirname(packagesPropsPath)
      : cargoTomlPath       ? path.dirname(cargoTomlPath)
      : process.cwd();
    console.log('\nCommitting...');
    const commitResult = commitPhaseA(projectDir, phaseA, ecosystem);
    if (commitResult.success) {
      console.log(`  Committed Phase A fixes: ${commitResult.message.split('\n')[0]}`);
    } else {
      console.warn(`  Warning: git commit failed: ${commitResult.message}`);
    }
  }

  if (autoCommitPhaseB && applyPhaseB && phaseB.length > 0) {
    const { commitPhaseBC } = require('./src/core/git-commits');
    const projectDir = packageJsonPath ? path.dirname(packageJsonPath)
      : pomXmlPath          ? path.dirname(pomXmlPath)
      : requirementsTxtPath ? path.dirname(requirementsTxtPath)
      : goModPath           ? path.dirname(goModPath)
      : packagesPropsPath   ? path.dirname(packagesPropsPath)
      : cargoTomlPath       ? path.dirname(cargoTomlPath)
      : process.cwd();
    console.log('\nCommitting Phase B...');
    const commitResult = commitPhaseBC(projectDir, phaseB, [], ecosystem);
    if (commitResult.success) {
      console.log(`  Committed Phase B fixes: ${commitResult.message.split('\n')[0]}`);
    } else {
      console.warn(`  Warning: git commit failed: ${commitResult.message}`);
    }
  }

  console.log('\nDone.');
  printNextSteps(ecosystem, outDir, packageJsonPath, pomXmlPath, requirementsTxtPath, goModPath, packagesPropsPath, cargoTomlPath, phaseA, phaseB, phaseC, applyPhaseB);
}

// ---------------------------------------------------------------------------
// Maven output writer
// ---------------------------------------------------------------------------

async function writeOutputMaven(phasedPlan, phaseA, phaseB, phaseC, outDir, pomXmlPath, reportContent) {
  if (phaseA.length > 0) {
    const p = writePomPatch(phasedPlan, outDir, 'A');
    if (p) console.log(`  Wrote: ${p}`);
  }

  if (phaseB.length > 0) {
    const p = writePomPatch(phasedPlan, outDir, 'B');
    if (p) console.log(`  Wrote: ${p}`);
  }

  if (phaseC.length > 0) {
    const p = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(p, buildManualReview(phaseC, 'maven'));
    console.log(`  Wrote: ${p}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!pomXmlPath) return;
  if (!fs.existsSync(pomXmlPath)) {
    console.warn(`  WARN: ${pomXmlPath} not found — skipping auto-apply`);
    return;
  }
  if (phaseA.length === 0) {
    console.log(`  No Phase A fixes to apply to ${pomXmlPath}`);
    return;
  }

  const conflicts   = detectMavenChanges(pomXmlPath, phaseA);
  const cleanPhaseA = phaseA.filter(i => !conflicts.find(c => c.pkgName === `${i.groupId}:${i.libraryName}`));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed entries (preserving your edits):`);
    for (const c of conflicts) {
      console.log(`     ${c.pkgName}: tool last wrote ${c.lastToolVersion}, currently ${c.currentVersion}`);
    }
  }

  if (cleanPhaseA.length === 0) {
    console.log(`  All Phase A entries were manually changed — nothing applied.`);
    return;
  }

  try {
    applyPomPatch(cleanPhaseA, pomXmlPath);
    for (const item of cleanPhaseA) {
      console.log(`  Applied : ${item.groupId}:${item.libraryName} → ${item.recommendedVersion}`);
    }
    console.log(`\n  Updated: ${pomXmlPath}`);

    console.log(`\n  Running: mvn dependency:resolve -B -q`);
    const result = runMavenResolve(path.dirname(pomXmlPath));
    if (!result.success) {
      console.warn(`  WARNING: mvn dependency:resolve failed (exit ${result.status})`);
      if (result.stderr) console.warn(`  ${result.stderr.slice(0, 500)}`);
    } else {
      console.log(`  OK — dependencies resolved`);
    }
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    console.log(`  No changes made.`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// npm output writer
// ---------------------------------------------------------------------------

async function writeOutputNpm(phasedPlan, phaseA, phaseB, phaseC, outDir, packageJsonPath, depTree, reportOpts, verifyVersions, applyPhaseB = false) {
  let directUpgrades     = [];
  let phaseAForOverrides = phaseA;

  let targetPkg = null;
  if (packageJsonPath && fs.existsSync(packageJsonPath)) {
    targetPkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  }

  if (depTree || targetPkg) {
    const split = detectDirectDeps(phaseA, targetPkg || {}, depTree);
    directUpgrades     = split.directUpgrades;
    phaseAForOverrides = split.overrideItems;
    for (const u of directUpgrades) {
      console.log(`  ${u.libraryName}: no transitive consumers — will bump directly`);
    }
  }

  const phaseAOverrides = buildPhaseAOverrides(phaseAForOverrides);
  const phaseBOverrides = buildPhaseBOverrides(phasedPlan);

  const phaseADependencies = {};
  for (const u of directUpgrades) phaseADependencies[u.libraryName] = u.recommendedVersion;

  const phaseAPath = path.join(outDir, 'phase-a-overrides.json');
  writeOverridesPatch(phaseAPath, phaseAOverrides, {
    comment: 'Phase A: High confidence (95-100%). Same-major patch/minor. Safe to apply.',
    confidence: '95-100%',
    dependencies: phaseADependencies,
  });
  console.log(`  Wrote: ${phaseAPath}`);

  if (Object.keys(phaseBOverrides).length > 0) {
    const phaseBPath = path.join(outDir, 'phase-b-overrides.json');
    writeOverridesPatch(phaseBPath, phaseBOverrides, {
      comment: 'Phase B: Medium confidence (60-95%). Review before applying.',
      confidence: '60-95%',
    });
    console.log(`  Wrote: ${phaseBPath}`);
  }

  const parentUpgradeMap = buildParentUpgradeMap(phasedPlan);
  if (Object.keys(parentUpgradeMap).length > 0) {
    const parentUpgradesPath = path.join(outDir, 'phase-b-parent-upgrades.json');
    const out = {
      _comment:      'Parent upgrades that transitively fix MAJOR_BUMP vulnerabilities (no override needed).',
      _confidence:   '70-85%',
      _verification: 'After updating each parent version: run `npm install --package-lock-only` and confirm the child resolves to the fix version in package-lock.json.',
      parentUpgrades: parentUpgradeMap,
    };
    fs.writeFileSync(parentUpgradesPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`  Wrote: ${parentUpgradesPath}`);
  }

  if (phaseC.length > 0) {
    const manualPath = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(manualPath, buildManualReview(phaseC, 'npm'));
    console.log(`  Wrote: ${manualPath}`);
  }

  // Regenerate report with directDeps so the overrides block correctly omits
  // packages that should be bumped directly in package.json.
  const directDeps = new Set(directUpgrades.map(u => u.libraryName));
  const reportContent = generateReport(phasedPlan, { ...reportOpts, directDeps });
  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!packageJsonPath) return;
  if (!fs.existsSync(packageJsonPath)) {
    console.warn(`  WARN: ${packageJsonPath} not found — skipping auto-apply`);
    return;
  }

  const hasPhaseBOverrides = applyPhaseB && Object.keys(phaseBOverrides).length > 0;
  const hasPhaseBParents   = applyPhaseB && Object.keys(parentUpgradeMap).length > 0;
  const hasAnyChanges = directUpgrades.length > 0 || Object.keys(phaseAOverrides).length > 0
    || hasPhaseBOverrides || hasPhaseBParents;

  if (!hasAnyChanges) {
    console.log(`  No fixes to apply to ${packageJsonPath}`);
    return;
  }

  // Idempotency check (Scenario 21) — only when applying Phase A only
  if (!applyPhaseB && isAlreadyApplied(packageJsonPath, phaseAOverrides, directUpgrades)) {
    console.log(`\n  Nothing to apply — current state matches the last manifest. Run cleanup if overrides are no longer needed.`);
    return;
  }

  const conflicts      = detectManualChanges(packageJsonPath, phaseAOverrides);
  const cleanOverrides = { ...phaseAOverrides };
  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed overrides (preserving your edits):`);
    for (const c of conflicts) {
      console.log(`     ${c.pkgName}: tool last wrote ${c.lastToolVersion}, currently ${c.currentVersion}`);
      delete cleanOverrides[c.pkgName];
    }
  }

  const installLockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
  // Capture graph before install so we can diff after (Item 14 — whole-graph diff)
  const graphBefore = captureGraph(installLockPath);
  const snapshots = snapshotFiles([packageJsonPath, installLockPath]);

  try {
    const rawPkgJson = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(rawPkgJson);

    const allDirectKeys = new Set([
      ...Object.keys(pkg.dependencies    || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ]);
    for (const pkgName of Object.keys(cleanOverrides)) {
      if (allDirectKeys.has(pkgName)) {
        console.log(`  NOTE: ${pkgName} is a direct dep — removed from overrides to prevent npm conflict`);
        delete cleanOverrides[pkgName];
      }
    }

    if (directUpgrades.length > 0) {
      applyDirectUpgrades(pkg, directUpgrades);
      for (const u of directUpgrades) {
        console.log(`  Direct bump : ${u.libraryName}  ${u.currentRange} → ${u.newRange}  (${u.isDev ? 'devDependencies' : 'dependencies'})`);
      }
    }

    if (Object.keys(cleanOverrides).length > 0) {
      pkg.overrides = { ...(pkg.overrides || {}), ...cleanOverrides };
      for (const [k, v] of Object.entries(cleanOverrides)) {
        console.log(`  Override A  : ${k} → ${v}`);
      }
    }

    // Phase B: apply overrides + parent bumps when --apply-phase-b is set
    const cleanPhaseBOverrides = { ...phaseBOverrides };
    if (hasPhaseBOverrides) {
      for (const pkgName of Object.keys(cleanPhaseBOverrides)) {
        if (allDirectKeys.has(pkgName)) {
          console.log(`  NOTE: ${pkgName} is a direct dep — removed from Phase B overrides to prevent npm conflict`);
          delete cleanPhaseBOverrides[pkgName];
        }
      }
      if (Object.keys(cleanPhaseBOverrides).length > 0) {
        pkg.overrides = { ...(pkg.overrides || {}), ...cleanPhaseBOverrides };
        for (const [k, v] of Object.entries(cleanPhaseBOverrides)) {
          console.log(`  Override B  : ${k} → ${v}`);
        }
      }
    }

    if (hasPhaseBParents) {
      for (const [parentName, info] of Object.entries(parentUpgradeMap)) {
        const section = info.isDev ? 'devDependencies' : 'dependencies';
        if (pkg[section] && pkg[section][parentName] !== undefined) {
          const oldRange = pkg[section][parentName];
          const newRange = `^${info.upgradeTo}`;
          pkg[section][parentName] = newRange;
          console.log(`  Parent bump : ${parentName}  ${oldRange} → ${newRange}  (fixes ${info.fixes} transitively)`);
        } else {
          // Fall back: check the other section (isDev might be wrong for monorepos)
          const altSection = info.isDev ? 'dependencies' : 'devDependencies';
          if (pkg[altSection] && pkg[altSection][parentName] !== undefined) {
            const oldRange = pkg[altSection][parentName];
            const newRange = `^${info.upgradeTo}`;
            pkg[altSection][parentName] = newRange;
            console.log(`  Parent bump : ${parentName}  ${oldRange} → ${newRange}  (fixes ${info.fixes} transitively, found in ${altSection})`);
          } else {
            console.log(`  WARN: ${parentName} not found in dependencies/devDependencies — skipping parent upgrade`);
          }
        }
      }
    }

    writeJson(packageJsonPath, rawPkgJson, pkg);

    console.log(`\n  Running: npm install --legacy-peer-deps --package-lock-only`);
    const installResult = runPackageLockUpdate(path.dirname(packageJsonPath));

    if (!installResult.success) {
      console.error(`  FAILED (exit ${installResult.status}):`);
      if (installResult.stderr) console.error(`  ${installResult.stderr.slice(0, 500)}`);
      restoreFiles(snapshots);
      console.log(`  Rolled back. No files changed.`);
      process.exitCode = 1;
      return true;
    }

    console.log(`  OK`);

    // Verify Phase A items
    const verifyItems = [
      ...directUpgrades,
      ...phaseAForOverrides.filter(i => cleanOverrides[i.libraryName]),
    ];

    // Verify Phase B override items (non-parent-upgrade)
    if (hasPhaseBOverrides) {
      const phaseBForOverrides = phaseB.filter(i => !i.parentUpgradePaths);
      verifyItems.push(...phaseBForOverrides.filter(i => cleanPhaseBOverrides[i.libraryName]));
    }

    // Verify Phase B parent upgrades by checking the child package in the lock
    if (hasPhaseBParents) {
      for (const [, info] of Object.entries(parentUpgradeMap)) {
        if (info.fixes && info.fixVersion) {
          verifyItems.push({ libraryName: info.fixes, recommendedVersion: info.fixVersion });
        }
      }
    }

    if (fs.existsSync(installLockPath) && verifyItems.length > 0) {
      const { failures, warnings } = verifyFixVersions(installLockPath, verifyItems);
      if (failures.length > 0) {
        console.error(`\n  ✗  Post-install verification FAILED — override had no effect, rolling back:`);
        for (const f of failures) {
          console.error(`     ${f.libraryName}: expected >=${f.expected}, got [${f.resolved.join(', ') || 'not found'}]`);
        }
        restoreFiles(snapshots);
        console.log(`  Rolled back. No files changed.`);
        process.exitCode = 1;
        return true;
      }
      if (warnings.length > 0) {
        console.log(`\n  ⚠  Partial coverage (nested copies remain — Phase B/C items):`);
        for (const w of warnings) {
          const old = w.resolved.filter(v => semver.lt(v, w.expected));
          console.log(`     ${w.libraryName}: ${old.join(', ')} still present alongside fixed version (see manual-review.md)`);
        }
      }
      const deduped = [...new Set(verifyItems.map(i => i.libraryName))];
      console.log(`  Verified: ${deduped.length} package(s) at fix version in lock file.`);
    }

    const directMap = {};
    for (const u of directUpgrades) directMap[u.libraryName] = u.recommendedVersion;
    saveManifest(packageJsonPath, { ...cleanOverrides, ...cleanPhaseBOverrides }, directMap);

    // Item 14 — whole-graph diff: compare resolved versions before vs after install
    if (fs.existsSync(installLockPath)) {
      const graphAfter = captureGraph(installLockPath);
      const diff = diffGraphs(graphBefore, graphAfter);
      const { added, removed, changed } = diff;
      if (added.length > 0 || removed.length > 0 || changed.length > 0) {
        const diffPath = path.join(outDir, 'graph-diff.md');
        const project  = path.basename(packageJsonPath, '.json');
        fs.writeFileSync(diffPath, formatDiff(diff, {
          project,
          reportDate: new Date().toISOString().split('T')[0],
        }));
        console.log(`  Wrote: ${diffPath}  (${changed.length} changed, ${added.length} added, ${removed.length} removed)`);
      } else {
        console.log(`  Graph diff: no version changes outside of targeted packages`);
      }
    }
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    restoreFiles(snapshots);
    console.log(`  Rolled back. No files changed.`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Python output writer
// ---------------------------------------------------------------------------

async function writeOutputPython(phasedPlan, phaseA, phaseB, phaseC, outDir, requirementsTxtPath, reportContent) {
  const {
    writeRequirementsPatch, applyPinsToRequirements,
    buildManualReview, saveManifest, detectManualChanges,
  } = require('./src/ecosystems/python/writer');

  const pA = writeRequirementsPatch(phasedPlan, outDir, 'A');
  if (pA) console.log(`  Wrote: ${pA}`);

  const pB = writeRequirementsPatch(phasedPlan, outDir, 'B');
  if (pB) console.log(`  Wrote: ${pB}`);

  if (phaseC.length > 0) {
    const p = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(p, buildManualReview(phaseC));
    console.log(`  Wrote: ${p}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!requirementsTxtPath || !fs.existsSync(requirementsTxtPath)) return false;
  if (phaseA.length === 0) {
    console.log(`  No Phase A fixes to apply to ${requirementsTxtPath}`);
    return false;
  }

  const conflicts   = detectManualChanges(requirementsTxtPath, phaseA);
  const cleanPhaseA = phaseA.filter(i => !conflicts.find(c => c.pkgName === i.libraryName));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed entries (preserving your edits):`);
    for (const c of conflicts) console.log(`     ${c.pkgName}: expected ${c.lastToolVersion}, currently ${c.currentVersion}`);
  }
  if (cleanPhaseA.length === 0) {
    console.log(`  All Phase A entries were manually changed — nothing applied.`);
    return false;
  }

  try {
    applyPinsToRequirements(requirementsTxtPath, cleanPhaseA);
    for (const item of cleanPhaseA) console.log(`  Applied: ${item.libraryName} → ${item.recommendedVersion}`);
    console.log(`\n  Updated: ${requirementsTxtPath}`);

    const { runPipInstall, verifyFixVersions: verifyPip } = require('./src/ecosystems/python/installer');
    console.log(`\n  Running: pip install -r ${path.basename(requirementsTxtPath)}`);
    const result = runPipInstall(path.dirname(requirementsTxtPath), requirementsTxtPath);
    if (!result.success) {
      console.warn(`  WARNING: pip install failed — ${(result.error || '').slice(0, 300)}`);
    } else {
      console.log(`  OK — dependencies installed`);
      const mismatches = verifyPip(cleanPhaseA, path.dirname(requirementsTxtPath));
      if (mismatches.length > 0) {
        console.warn(`  ⚠  Version mismatches after install:`);
        for (const m of mismatches) console.warn(`     ${m.name}: expected ${m.expected}, got ${m.actual}`);
      } else {
        console.log(`  Verified: ${cleanPhaseA.length} package(s) at fix version`);
      }
    }
    saveManifest(outDir, cleanPhaseA);
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Go output writer
// ---------------------------------------------------------------------------

async function writeOutputGo(phasedPlan, phaseA, phaseB, phaseC, outDir, goModPath, reportContent) {
  const {
    writeGoModPatch, applyReplaceDirectives,
    buildManualReview, saveManifest, detectManualChanges,
  } = require('./src/ecosystems/go/writer');

  const pA = writeGoModPatch(phasedPlan, outDir, 'A');
  if (pA) console.log(`  Wrote: ${pA}`);

  const pB = writeGoModPatch(phasedPlan, outDir, 'B');
  if (pB) console.log(`  Wrote: ${pB}`);

  if (phaseC.length > 0) {
    const p = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(p, buildManualReview(phaseC));
    console.log(`  Wrote: ${p}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!goModPath || !fs.existsSync(goModPath)) return false;
  if (phaseA.length === 0) {
    console.log(`  No Phase A fixes to apply to ${goModPath}`);
    return false;
  }

  const conflicts   = detectManualChanges(goModPath, phaseA);
  const cleanPhaseA = phaseA.filter(i => !conflicts.find(c => c.pkgName === i.libraryName));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed entries (preserving your edits):`);
    for (const c of conflicts) console.log(`     ${c.pkgName}: expected ${c.lastToolVersion}, currently ${c.currentVersion}`);
  }
  if (cleanPhaseA.length === 0) {
    console.log(`  All Phase A entries were manually changed — nothing applied.`);
    return false;
  }

  try {
    applyReplaceDirectives(goModPath, cleanPhaseA);
    for (const item of cleanPhaseA) console.log(`  Applied: ${item.libraryName} → ${item.recommendedVersion}`);
    console.log(`\n  Updated: ${goModPath}`);

    const { runGoModTidy, runGoModVerify, verifyFixVersions: verifyGo } = require('./src/ecosystems/go/installer');
    const projectDir = path.dirname(goModPath);
    console.log(`\n  Running: go mod tidy`);
    const tidyResult = runGoModTidy(projectDir);
    if (!tidyResult.success) {
      console.warn(`  WARNING: go mod tidy failed — ${(tidyResult.error || '').slice(0, 300)}`);
    } else {
      console.log(`  OK — go mod tidy succeeded`);
      const mismatches = verifyGo(cleanPhaseA, projectDir);
      if (mismatches.length > 0) {
        console.warn(`  ⚠  Version mismatches after tidy:`);
        for (const m of mismatches) console.warn(`     ${m.name}: expected ${m.expected}, got ${m.actual}`);
      } else {
        console.log(`  Verified: ${cleanPhaseA.length} module(s) at fix version`);
      }
    }
    saveManifest(outDir, cleanPhaseA);
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// .NET output writer
// ---------------------------------------------------------------------------

async function writeOutputDotnet(phasedPlan, phaseA, phaseB, phaseC, outDir, packagesPropsPath, reportContent) {
  const {
    writePackagesPropsPatch, applyVersionPins,
    buildManualReview, saveManifest, detectManualChanges,
  } = require('./src/ecosystems/dotnet/writer');

  const pA = writePackagesPropsPatch(phasedPlan, outDir, 'A');
  if (pA) console.log(`  Wrote: ${pA}`);
  const pB = writePackagesPropsPatch(phasedPlan, outDir, 'B');
  if (pB) console.log(`  Wrote: ${pB}`);

  if (phaseC.length > 0) {
    const p = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(p, buildManualReview(phaseC));
    console.log(`  Wrote: ${p}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!packagesPropsPath || !fs.existsSync(packagesPropsPath)) return false;
  if (phaseA.length === 0) {
    console.log(`  No Phase A fixes to apply to ${packagesPropsPath}`);
    return false;
  }

  const conflicts   = detectManualChanges(packagesPropsPath, phaseA);
  const cleanPhaseA = phaseA.filter(i => !conflicts.find(c => c.pkgName === i.libraryName));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed entries (preserving your edits):`);
    for (const c of conflicts) console.log(`     ${c.pkgName}: expected ${c.lastToolVersion}, currently ${c.currentVersion}`);
  }
  if (cleanPhaseA.length === 0) {
    console.log(`  All Phase A entries were manually changed — nothing applied.`);
    return false;
  }

  try {
    applyVersionPins(packagesPropsPath, cleanPhaseA);
    for (const item of cleanPhaseA) console.log(`  Applied: ${item.libraryName} → ${item.recommendedVersion}`);
    console.log(`\n  Updated: ${packagesPropsPath}`);

    const { runDotnetRestore, verifyFixVersions: verifyDotnet } = require('./src/ecosystems/dotnet/installer');
    console.log(`\n  Running: dotnet restore`);
    const result = runDotnetRestore(path.dirname(packagesPropsPath));
    if (!result.success) {
      console.warn(`  WARNING: dotnet restore failed — ${(result.error || '').slice(0, 300)}`);
    } else {
      console.log(`  OK — packages restored`);
      const mismatches = verifyDotnet(cleanPhaseA, path.dirname(packagesPropsPath));
      if (mismatches.length > 0) {
        console.warn(`  ⚠  Version mismatches after restore:`);
        for (const m of mismatches) console.warn(`     ${m.name}: expected ${m.expected}, got ${m.actual}`);
      } else {
        console.log(`  Verified: ${cleanPhaseA.length} package(s) at fix version`);
      }
    }
    saveManifest(outDir, cleanPhaseA);
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rust output writer
// ---------------------------------------------------------------------------

async function writeOutputRust(phasedPlan, phaseA, phaseB, phaseC, outDir, cargoTomlPath, reportContent) {
  const {
    writeCargoTomlPatch, applyVersionPins,
    buildManualReview, saveManifest, detectManualChanges,
  } = require('./src/ecosystems/rust/writer');

  const pA = writeCargoTomlPatch(phasedPlan, outDir, 'A');
  if (pA) console.log(`  Wrote: ${pA}`);
  const pB = writeCargoTomlPatch(phasedPlan, outDir, 'B');
  if (pB) console.log(`  Wrote: ${pB}`);

  if (phaseC.length > 0) {
    const p = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(p, buildManualReview(phaseC));
    console.log(`  Wrote: ${p}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!cargoTomlPath || !fs.existsSync(cargoTomlPath)) return false;
  if (phaseA.length === 0) {
    console.log(`  No Phase A fixes to apply to ${cargoTomlPath}`);
    return false;
  }

  const conflicts   = detectManualChanges(cargoTomlPath, phaseA);
  const cleanPhaseA = phaseA.filter(i => !conflicts.find(c => c.pkgName === i.libraryName));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠  Skipping manually-changed entries (preserving your edits):`);
    for (const c of conflicts) console.log(`     ${c.pkgName}: expected ${c.lastToolVersion}, currently ${c.currentVersion}`);
  }
  if (cleanPhaseA.length === 0) {
    console.log(`  All Phase A entries were manually changed — nothing applied.`);
    return false;
  }

  try {
    applyVersionPins(cargoTomlPath, cleanPhaseA);
    for (const item of cleanPhaseA) console.log(`  Applied: ${item.libraryName} → ${item.recommendedVersion}`);
    console.log(`\n  Updated: ${cargoTomlPath}`);

    const { runCargoUpdate, verifyFixVersions: verifyRust } = require('./src/ecosystems/rust/installer');
    const projectDir = path.dirname(cargoTomlPath);
    console.log(`\n  Running: cargo update --precise`);
    const result = runCargoUpdate(cleanPhaseA, projectDir);
    if (!result.success) {
      console.warn(`  WARNING: cargo update failed — ${(result.error || '').slice(0, 300)}`);
    } else {
      console.log(`  OK — Cargo.lock updated`);
      const mismatches = verifyRust(cleanPhaseA, projectDir);
      if (mismatches.length > 0) {
        console.warn(`  ⚠  Version mismatches in Cargo.lock:`);
        for (const m of mismatches) console.warn(`     ${m.name}: expected ${m.expected}, got ${m.actual}`);
      } else {
        console.log(`  Verified: ${cleanPhaseA.length} crate(s) at fix version`);
      }
    }
    saveManifest(outDir, cleanPhaseA);
  } catch (err) {
    console.error(`  ERROR during apply: ${err.message}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Next-steps summary
// ---------------------------------------------------------------------------

function printNextSteps(ecosystem, outDir, packageJsonPath, pomXmlPath, requirementsTxtPath, goModPath, packagesPropsPath, cargoTomlPath, phaseA, phaseB, phaseC, appliedPhaseB = false) {
  const targetApplied = ecosystem === 'maven'  ? pomXmlPath
    : ecosystem === 'python' ? requirementsTxtPath
    : ecosystem === 'go'     ? goModPath
    : ecosystem === 'dotnet' ? packagesPropsPath
    : ecosystem === 'rust'   ? cargoTomlPath
    : packageJsonPath;
  const pendingPhaseB = phaseB.length > 0 && !appliedPhaseB;
  const hasNextSteps  = !targetApplied || pendingPhaseB || phaseC.length > 0;
  if (!hasNextSteps) return;

  console.log('\nNext steps:');
  let step = 1;

  if (!targetApplied && phaseA.length > 0) {
    if (ecosystem === 'maven') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-pom-patch.xml')}`);
      console.log(`  ${step++}. Add the <dependencyManagement> entries to your pom.xml`);
      console.log(`  ${step++}. Run: mvn dependency:resolve`);
    } else if (ecosystem === 'python') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-requirements.txt')}`);
      console.log(`  ${step++}. Merge Phase A pins into your requirements file`);
      console.log(`  ${step++}. Run: pip install -r requirements.txt`);
    } else if (ecosystem === 'go') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-go-mod.txt')}`);
      console.log(`  ${step++}. Add the replace directives to your go.mod`);
      console.log(`  ${step++}. Run: go mod tidy`);
    } else if (ecosystem === 'dotnet') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-packages-props.xml')}`);
      console.log(`  ${step++}. Merge PackageVersion entries into Directory.Packages.props`);
      console.log(`  ${step++}. Run: dotnet restore`);
    } else if (ecosystem === 'rust') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-cargo-toml.txt')}`);
      console.log(`  ${step++}. Apply the pinned versions to your Cargo.toml`);
      console.log(`  ${step++}. Run: cargo update --precise <version> for each crate`);
    } else {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-overrides.json')}`);
      console.log(`  ${step++}. Merge Phase A overrides into your project's package.json`);
      console.log(`  ${step++}. Run: npm install --package-lock-only --legacy-peer-deps`);
    }
  }

  if (pendingPhaseB) {
    const hasParentUpgrades = phaseB.some(i => i.parentUpgradePaths);
    const hasOverrides      = phaseB.some(i => !i.parentUpgradePaths);
    if (hasOverrides) {
      const patchFile = ecosystem === 'maven'   ? path.join(outDir, 'phase-b-pom-patch.xml')
        : ecosystem === 'python' ? path.join(outDir, 'phase-b-requirements.txt')
        : ecosystem === 'go'     ? path.join(outDir, 'phase-b-go-mod.txt')
        : ecosystem === 'dotnet' ? path.join(outDir, 'phase-b-packages-props.xml')
        : ecosystem === 'rust'   ? path.join(outDir, 'phase-b-cargo-toml.txt')
        : path.join(outDir, 'phase-b-overrides.json');
      console.log(`  ${step++}. Review ${patchFile} — then re-run with --apply-phase-b to auto-apply`);
    }
    if (hasParentUpgrades && ecosystem === 'npm') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-b-parent-upgrades.json')} — then re-run with --apply-phase-b to auto-apply parent bumps`);
    }
  }

  if (phaseC.length > 0) {
    console.log(`  ${step++}. Review ${path.join(outDir, 'manual-review.md')} — justification required`);
  }

  console.log(`\n  Full report: ${path.join(outDir, 'remediation-report.md')}`);
}

// ---------------------------------------------------------------------------
// Manual review document builder (Scenario 24 — was phase-c-review.md)
// ---------------------------------------------------------------------------

function buildManualReview(phaseCItems, ecosystem) {
  const isMaven = ecosystem === 'maven';

  const lines = [
    `# Manual Review Required`,
    ``,
    `These items require manual review before any fix is applied.`,
    `Confidence: <60% — do not auto-apply.`,
    ``,
  ];

  for (const r of phaseCItems) {
    const fixDisplay = r.recommendedVersion || 'NO FIX AVAILABLE';
    const cves = r.cves.map(c => c.id).join(', ');
    const fpTag = r.probableFalsePositive ? ' ⚠️ Probable False Positive' : '';

    lines.push(`## \`${r.libraryName}\` — ${r.currentVersion} → ${fixDisplay}${fpTag}`);
    lines.push(``);
    lines.push(`- **Decision:** ${r.decisionLabel || 'MANUAL_SECURITY_REVIEW'}`);
    lines.push(`- **Upgrade type:** ${r.upgradeType}`);
    lines.push(`- **Severity:** ${r.highestSeverity} (CVSS ${r.highestCvssScore})`);
    lines.push(`- **CVEs:** ${cves}`);
    lines.push(`- **Justification:** ${r.justification}`);

    if (r.depChain && r.depChain.length > 1) {
      lines.push(`- **Dependency chain:** ${r.depChain.join(' → ')}`);
    }
    if (r.rootParents && r.rootParents.length > 0) {
      const parentList = r.rootParents
        .map(p => `\`${p.name}\` (${p.range}${p.isDev ? ', dev' : ''})`)
        .join(', ');
      lines.push(`- **Root dependencies that pull this in:** ${parentList}`);
    }

    lines.push(``);
    lines.push(`### Required actions`);
    lines.push(``);

    if (r.upgradeType === 'MAJOR_BUMP') {
      const fromMajor = semver.major(r.currentVersion);
      const toMajor   = r.recommendedVersion ? semver.major(r.recommendedVersion) : '?';
      if (r.rootParents && r.rootParents.length > 0) {
        const parentNames = r.rootParents.map(p => `\`${p.name}\``).join(', ');
        // If --verify-versions was run, exploration already checked and found nothing.
        // Otherwise, recommend the manual check.
        const explorationNote = r._parentExplorationRan
          ? `No semver-compatible parent upgrade path was found automatically — a major bump of ${parentNames} may be required.`
          : `Check if upgrading ${parentNames} to a newer version ships \`${r.libraryName}\` at a patched version (run with --verify-versions to automate this check).`;
        lines.push(`- [ ] ${explorationNote}`);
      }
      lines.push(`- [ ] Review changelog from ${r.libraryName} v${fromMajor} → v${toMajor}`);
      lines.push(`- [ ] Check all call sites for API changes`);
      lines.push(`- [ ] Run full test suite after upgrade`);
      if (isMaven) {
        lines.push(`- [ ] Add a <dependencyManagement> entry and run \`mvn dependency:resolve\``);
        lines.push(`- [ ] Run: \`mvn dependency:tree -Dincludes=${r.groupId || 'GROUP_ID'}:${r.libraryName}\``);
      } else {
        lines.push(`- [ ] Check if a direct dependency can be upgraded instead of using an override`);
      }
    } else if (r.upgradeType === 'NO_FIX') {
      if (r.probableFalsePositive) {
        if (isMaven) {
          lines.push(`- [ ] Confirm scope: run \`mvn dependency:tree -Dincludes=${r.groupId || 'GROUP_ID'}:${r.libraryName}\``);
          lines.push(`- [ ] If only test/provided scope: document as false positive with justification`);
        } else {
          lines.push(`- [ ] Confirm dev-only classification: run \`npm ls ${r.libraryName} --prod\``);
          lines.push(`- [ ] If no prod output: document as false positive with justification`);
        }
      } else {
        lines.push(`- [ ] Determine if ${r.libraryName} is reachable at runtime (or build/test only)`);
        lines.push(`- [ ] If build/test only: document as false positive with justification`);
        lines.push(`- [ ] If runtime: monitor for upstream patch; consider replacing the library`);
      }
    } else {
      if (isMaven) {
        lines.push(`- [ ] Run \`mvn dependency:tree -Dincludes=${r.groupId || 'GROUP_ID'}:${r.libraryName}\` to see the full dependency chain`);
        lines.push(`- [ ] Add parent-specific exclusions or managed versions in the consuming POM`);
        lines.push(`- [ ] Test affected modules after applying any version change`);
      } else {
        lines.push(`- [ ] Run \`npm ls ${r.libraryName}\` in your project to see the full dependency chain`);
        lines.push(`- [ ] Use nested overrides keyed by parent package (requires package-lock.json analysis)`);
        lines.push(`- [ ] Test affected packages after applying any override`);
      }
    }

    lines.push(``);
  }

  return lines.join('\n');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
