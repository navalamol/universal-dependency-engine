#!/usr/bin/env node
'use strict';

const fs     = require('fs');
const path   = require('path');
const semver = require('semver');
const { spawnSync } = require('child_process');

const { applyPhases }           = require('./src/core/phases');
const { enrichWithConfidence }  = require('./src/core/confidence');
const { verifyPlanVersions }    = require('./src/ecosystems/npm/registry');
const { parseLockFile }         = require('./src/ecosystems/npm/lock-parser');
const {
  detectDirectDeps,
  applyDirectUpgrades,
  buildPhaseBOverrides,
  writeOverridesPatch,
  applyOverridesToPackageJson,
} = require('./src/ecosystems/npm/overrides');
const {
  snapshotFiles,
  restoreFiles,
  runPackageLockUpdate,
  verifyFixVersions,
  saveManifest,
  detectManualChanges,
} = require('./src/ecosystems/npm/installer');
const { fetchRenovatePRs, postComment, closePR } = require('./src/providers/github');
const { parsePRTitleNew }          = require('./src/core/renovate-classifier');
const { buildResolutionItems }  = require('./src/core/renovate-builder');
const { writeApplyReport }      = require('./src/core/renovate-apply-report');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    config:         null,
    githubToken:    process.env.GITHUB_TOKEN || null,
    cloneDir:       './repos',
    outDir:         null,
    apply:          false,
    verifyVersions: false,
    closePRs:       false,
    dryRun:         false,
    includePRs:     null,   // comma-separated PR numbers to include
    excludePRs:     null,   // comma-separated PR numbers to exclude
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--config')          args.config         = argv[++i];
    else if (a === '--github-token')    args.githubToken    = argv[++i];
    else if (a === '--clone-dir')       args.cloneDir       = argv[++i];
    else if (a === '--out-dir')         args.outDir         = argv[++i];
    else if (a === '--apply')           args.apply          = true;
    else if (a === '--verify-versions') args.verifyVersions = true;
    else if (a === '--close-prs')       args.closePRs       = true;
    else if (a === '--dry-run')         args.dryRun         = true;
    else if (a === '--include-prs')     args.includePRs     = argv[++i];
    else if (a === '--exclude-prs')     args.excludePRs     = argv[++i];
    else if (a === '--help') { printUsage(); process.exit(0); }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: mendfix renovate --config <repos.json> [options]
       node renovate-apply.js --config <repos.json> [options]

Options:
  --config <path>         Repos config JSON (required)
  --github-token <token>  GitHub token (or set GITHUB_TOKEN env var)
  --clone-dir <path>      Where to clone repos (default: ./repos)
  --out-dir <path>        Base path for output dirs; default is inside each clone
  --apply                 Write package.json changes + run npm install --package-lock-only
  --verify-versions       Check npm registry to confirm proposed versions exist
  --close-prs             Close Phase A PRs with a comment after applying
  --dry-run               Analyze only — no file changes, no PR closes; prints analysis to stdout
  --include-prs <nums>    Only process these PR numbers (comma-separated, e.g. 42,47,51)
  --exclude-prs <nums>    Skip these PR numbers (comma-separated, e.g. 42,47)
  --help                  Print this message

repos.json:
  { "org": "riversandtechnologies", "repos": [{ "name": "ui-platform" }, ...] }

Output files written per repo (in --out-dir/<repo> or <clone-dir>/<repo>/output-renovate-<repo>):
  phase-a-overrides.json   — safe same-major upgrades, auto-applicable
  phase-b-overrides.json   — review-before-apply (if any)
  manual-review.md         — Phase C items requiring manual action
  renovate-report.md       — full analysis summary
`);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function cloneOrPull(org, repoName, cloneDir, token) {
  const repoUrl = `https://github.com/${org}/${repoName}.git`;
  const targetDir = path.resolve(cloneDir, repoName);

  // Token passed via git credential helper environment variable, never embedded in URL
  const gitEnv = token
    ? {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      }
    : process.env;

  if (fs.existsSync(path.join(targetDir, 'package.json'))) {
    console.log(`  Pulling latest ${repoName}...`);
    const r = spawnSync('git', ['-C', targetDir, 'pull', '--ff-only'], { encoding: 'utf8', env: gitEnv });
    if (r.status !== 0) console.warn(`  Warning: git pull failed: ${r.stderr.trim()}`);
  } else {
    console.log(`  Cloning ${org}/${repoName}...`);
    if (!fs.existsSync(cloneDir)) fs.mkdirSync(cloneDir, { recursive: true });
    const r = spawnSync('git', ['clone', '--depth=1', repoUrl, targetDir], { encoding: 'utf8', env: gitEnv });
    if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr.trim()}`);
  }

  return targetDir;
}

// ---------------------------------------------------------------------------
// Write package.json helper
// ---------------------------------------------------------------------------

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Output directory resolution
// ---------------------------------------------------------------------------

function resolveOutDir(args, repoName, repoDir) {
  if (args.outDir) return path.resolve(args.outDir, repoName);
  return path.join(repoDir, `output-renovate-${repoName}`);
}

// ---------------------------------------------------------------------------
// Manual review document (Phase C items)
// ---------------------------------------------------------------------------

function buildManualReview(phaseCItems, repoName) {
  const lines = [
    `# Manual Review Required — Renovate PRs`,
    ``,
    `Repository: ${repoName}`,
    ``,
    `The following Renovate PRs were classified Phase C (<60% confidence). Do not auto-apply.`,
    ``,
  ];

  for (const item of phaseCItems) {
    const fixDisplay = item.recommendedVersion || 'UNKNOWN';
    lines.push(`## PR #${item.prNumber}: \`${item.libraryName}\` ${item.currentVersion} → ${fixDisplay}`);
    lines.push(``);
    if (item.prTitle) lines.push(`- **PR title:** ${item.prTitle}`);
    lines.push(`- **Upgrade type:** ${item.upgradeType}`);
    lines.push(`- **Justification:** ${item.justification}`);
    if (item.evidence)    lines.push(`- **Evidence:** ${item.evidence}`);
    if (item.alternative) lines.push(`- **Alternative:** ${item.alternative}`);
    lines.push(``);
    lines.push(`### Required actions`);
    lines.push(``);

    if (item.upgradeType === 'MAJOR_BUMP') {
      const fromMajor = semver.valid(item.currentVersion) ? semver.major(item.currentVersion) : '?';
      const toMajor   = item.recommendedVersion && semver.valid(item.recommendedVersion)
        ? semver.major(item.recommendedVersion) : '?';
      lines.push(`- [ ] Review changelog from \`${item.libraryName}\` v${fromMajor} → v${toMajor}`);
      lines.push(`- [ ] Check all call sites for breaking API changes`);
      lines.push(`- [ ] Run full test suite after upgrade`);
      lines.push(`- [ ] Check if a direct dependency can be upgraded instead of using an override`);
    } else {
      lines.push(`- [ ] Run \`npm ls ${item.libraryName}\` to trace the full dependency chain`);
      lines.push(`- [ ] Use nested overrides keyed by parent package if a flat override is unsafe`);
      lines.push(`- [ ] Test affected packages after applying any override`);
    }

    lines.push(``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-repo apply logic
// ---------------------------------------------------------------------------

async function writeOutputRenovate({
  phasedItems, pkg, repoDir, packageJsonPath, lockFilePath,
  outDir, apply, dryRun, repoName, org, runDate, depTree, notFound,
}) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const phaseA = phasedItems.filter(i => i.phase === 'A');
  const phaseB = phasedItems.filter(i => i.phase === 'B');
  const phaseC = phasedItems.filter(i => i.phase === 'C');

  // --- Split Phase A into direct dep bumps vs overrides ---
  const { directUpgrades, overrideItems: phaseAOverrideItems } =
    detectDirectDeps(phaseA, pkg, depTree);

  // Tag items for report display
  for (const item of directUpgrades)     item._directUpgrade = true;
  for (const item of phaseAOverrideItems) item._directUpgrade = false;

  // --- Build override maps ---
  // Build Phase A overrides only from items that need a transitive override (not direct dep bumps).
  const phaseAOverridesClean = {};
  for (const item of phaseAOverrideItems) {
    if (item.recommendedVersion) phaseAOverridesClean[item.libraryName] = item.recommendedVersion;
  }
  const phaseBOverrides = buildPhaseBOverrides(phasedItems);

  // --- Write patch files ---
  const directDepsMap = {};
  for (const item of directUpgrades) if (item.newRange) directDepsMap[item.libraryName] = item.newRange;

  writeOverridesPatch(
    path.join(outDir, 'phase-a-overrides.json'),
    phaseAOverridesClean,
    {
      comment: 'Renovate-apply: Phase A safe overrides. Merge into package.json overrides.',
      confidence: '95-100%',
      dependencies: directDepsMap,
    }
  );

  if (Object.keys(phaseBOverrides).length > 0) {
    writeOverridesPatch(
      path.join(outDir, 'phase-b-overrides.json'),
      phaseBOverrides,
      {
        comment: 'Renovate-apply: Phase B overrides — review before applying.',
        confidence: '60-95%',
      }
    );
  }

  if (phaseC.length > 0) {
    fs.writeFileSync(path.join(outDir, 'manual-review.md'), buildManualReview(phaseC, repoName), 'utf8');
  }

  // --- Apply phase (optional) ---
  let applied = false;
  let verifyFailures = [];
  const errors = [];

  if ((apply || false) && !dryRun) {
    if (phaseA.length === 0) {
      console.log('  No Phase A items — nothing to apply.');
    } else {
      const snapshots = snapshotFiles([packageJsonPath, lockFilePath]);

      // Conflict detection — skip overrides the user manually edited
      const conflicts = detectManualChanges(packageJsonPath, phaseAOverridesClean);
      const cleanOverrides = { ...phaseAOverridesClean };
      for (const c of conflicts) {
        console.warn(`  Skipping ${c.pkgName} — manual edit detected (was ${c.lastToolVersion}, now ${c.currentVersion})`);
        delete cleanOverrides[c.pkgName];
      }

      // Remove packages that are direct deps (npm override + direct dep conflict)
      const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      for (const pkgName of Object.keys(cleanOverrides)) {
        if (allDeps[pkgName] !== undefined) delete cleanOverrides[pkgName];
      }

      // Apply overrides (reads disk, merges, returns updated pkg), then apply direct bumps, then write once.
      let updatedPkg = applyOverridesToPackageJson(packageJsonPath, cleanOverrides);
      updatedPkg = applyDirectUpgrades(updatedPkg, directUpgrades);
      writeJson(packageJsonPath, updatedPkg);

      // Run npm install --package-lock-only
      console.log('  Running npm install --package-lock-only...');
      const installResult = runPackageLockUpdate(path.dirname(packageJsonPath));

      if (!installResult.success) {
        console.error(`  npm install failed (exit ${installResult.status}): ${installResult.stderr.slice(0, 200)}`);
        restoreFiles(snapshots);
        errors.push(`npm install failed — rolled back. Exit code: ${installResult.status}`);
      } else {
        // Post-install verification — rollback only when override had zero effect
        const allApplied = [...directUpgrades, ...phaseAOverrideItems];
        const { failures: vFails, warnings: vWarns } = verifyFixVersions(lockFilePath, allApplied);
        verifyFailures = vFails;
        if (vWarns.length > 0) {
          for (const w of vWarns) {
            const old = w.resolved.filter(v => semver.lt(v, w.expected));
            console.log(`  ⚠  ${w.libraryName}: nested copies at ${old.join(', ')} remain (Phase B/C — see manual-review.md)`);
          }
        }
        if (vFails.length > 0) {
          for (const f of vFails) {
            console.error(`  Verification FAILED: ${f.libraryName} expected >= ${f.expected}, got [${f.resolved.join(', ')}]`);
          }
          restoreFiles(snapshots);
          errors.push(`Post-install verification failed for ${vFails.map(f => f.libraryName).join(', ')} — rolled back`);
          console.log(`  Rolled back. No files changed.`);
        } else {
          applied = true;

          // Save manifest for idempotency / manual-change detection on future runs
          const directMap = {};
          for (const item of directUpgrades) directMap[item.libraryName] = item.newRange || item.recommendedVersion;
          saveManifest(packageJsonPath, cleanOverrides, directMap);

          // Tag items as applied for report
          for (const item of [...directUpgrades, ...phaseAOverrideItems]) item._applied = true;
          console.log(`  Applied ${directUpgrades.length} direct dep bump(s) + ${Object.keys(cleanOverrides).length} override(s).`);
        }
      }
    }
  } else if (dryRun && phaseA.length > 0) {
    console.log(`  [dry-run] Would apply ${directUpgrades.length} direct dep bump(s) + ${Object.keys(phaseAOverridesClean).length} override(s).`);
  }

  // --- Write report ---
  writeApplyReport({
    repoName, org, runDate,
    phasedItems,
    notFound,
    applied,
    verifyFailures,
    errors,
  }, outDir);

  return { applied, errors, phaseA, phaseB, phaseC, notFound };
}

// ---------------------------------------------------------------------------
// Per-repo orchestration
// ---------------------------------------------------------------------------

async function processRepo(repoConfig, org, args, runDate) {
  const { name: repoName } = repoConfig;
  console.log(`\n[${repoName}]`);

  const errors = [];
  let repoDir = null;

  // 1. Clone / pull
  try {
    repoDir = cloneOrPull(org, repoName, args.cloneDir, args.githubToken);
  } catch (err) {
    console.error(`  Clone failed: ${err.message}`);
    return { repoName, org, errors: [`Clone failed: ${err.message}`] };
  }

  const packageJsonPath = path.join(repoDir, 'package.json');
  const lockFilePath    = path.join(repoDir, 'package-lock.json');

  if (!fs.existsSync(packageJsonPath)) {
    const hasPom = fs.existsSync(path.join(repoDir, 'pom.xml'));
    const msg = hasPom
      ? `Repository ${repoName} appears to be a Maven project (pom.xml found, no package.json). ` +
        `The Renovate apply workflow currently supports npm only. Maven support requires --pom-xml support (P1-7).`
      : `package.json not found in cloned repo: ${packageJsonPath}`;
    console.error(`  ${msg}`);
    return { repoName, org, errors: [msg] };
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // 2. Parse lock file if present
  let depTree = null;
  if (fs.existsSync(lockFilePath)) {
    try {
      depTree = parseLockFile(lockFilePath);
    } catch (err) {
      console.warn(`  Warning: could not parse lock file: ${err.message}`);
    }
  }

  // 3. Fetch Renovate PRs
  let renovatePRs = [];
  if (!args.githubToken) {
    console.warn('  No GitHub token — skipping PR fetch. Pass --github-token or set GITHUB_TOKEN.');
  } else {
    try {
      renovatePRs = await fetchRenovatePRs(org, repoName, args.githubToken);
      console.log(`  Found ${renovatePRs.length} open Renovate PR(s)`);
    } catch (err) {
      const msg = `GitHub PR fetch failed: ${err.message}`;
      errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // 3b. Selective PR filtering (--include-prs / --exclude-prs)
  if (args.includePRs) {
    const include = new Set(args.includePRs.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean));
    const before = renovatePRs.length;
    renovatePRs = renovatePRs.filter(pr => include.has(pr.number));
    console.log(`  --include-prs filter: kept ${renovatePRs.length}/${before} PR(s)`);
  }
  if (args.excludePRs) {
    const exclude = new Set(args.excludePRs.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean));
    const before = renovatePRs.length;
    renovatePRs = renovatePRs.filter(pr => !exclude.has(pr.number));
    console.log(`  --exclude-prs filter: excluded ${before - renovatePRs.length} PR(s), ${renovatePRs.length} remaining`);
  }

  // 4. Parse PR titles → upgrade intents
  const prUpgrades = [];
  const unparseable = [];
  for (const pr of renovatePRs) {
    const parsed = parsePRTitleNew(pr.title);
    if (parsed) {
      prUpgrades.push({ prNumber: pr.number, prTitle: pr.title, prUrl: pr.html_url, ...parsed });
    } else {
      unparseable.push(pr);
    }
  }
  if (unparseable.length > 0) {
    console.log(`  ${unparseable.length} PR(s) skipped (title not parseable as package upgrade)`);
  }

  // 5. Build resolution items from Renovate data
  const { items: resolutionItems, notFound } = buildResolutionItems(prUpgrades, pkg, depTree);
  if (notFound.length > 0) {
    console.log(`  ${notFound.length} package(s) not found in repo — will appear in report`);
  }

  if (resolutionItems.length === 0 && notFound.length === 0) {
    console.log('  No upgradeable packages found — nothing to do.');
  }

  // 6. Phase classification + confidence enrichment
  let phasedItems = applyPhases(resolutionItems, depTree);
  phasedItems = enrichWithConfidence(phasedItems, depTree);

  // 7. Optional registry verification
  if (args.verifyVersions && phasedItems.length > 0) {
    console.log('  Verifying proposed versions against npm registry...');
    phasedItems = await verifyPlanVersions(phasedItems);
  }

  // Attach PR metadata back to phased items (applyPhases strips unknown fields)
  const prMeta = new Map(resolutionItems.map(i => [i.libraryName, { prNumber: i.prNumber, prTitle: i.prTitle }]));
  for (const item of phasedItems) {
    const meta = prMeta.get(item.libraryName);
    if (meta) { item.prNumber = meta.prNumber; item.prTitle = meta.prTitle; }
  }

  const phaseA = phasedItems.filter(i => i.phase === 'A');
  const phaseB = phasedItems.filter(i => i.phase === 'B');
  const phaseC = phasedItems.filter(i => i.phase === 'C');
  console.log(`  Phase A: ${phaseA.length}  B: ${phaseB.length}  C: ${phaseC.length}  NotFound: ${notFound.length}`);

  if (args.dryRun) {
    const bar = '─'.repeat(60);
    console.log(`\n  ${bar}`);
    if (phaseA.length > 0) {
      console.log(`\n  Phase A — safe upgrades (would be auto-applied):`);
      for (const item of phaseA) {
        const type = item._directUpgrade ? 'direct dep' : 'override';
        console.log(`    ✅ PR #${item.prNumber}: ${item.libraryName} ${item.currentVersion} → ${item.recommendedVersion} [${type}]`);
      }
    }
    if (phaseB.length > 0) {
      console.log(`\n  Phase B — review before applying:`);
      for (const item of phaseB) {
        console.log(`    ⚠️  PR #${item.prNumber}: ${item.libraryName} ${item.currentVersion} → ${item.recommendedVersion}`);
        console.log(`         ${item.justification}`);
      }
    }
    if (phaseC.length > 0) {
      console.log(`\n  Phase C — manual review required (NOT applied):`);
      for (const item of phaseC) {
        const fix = item.recommendedVersion || 'NO FIX';
        console.log(`    ❌ PR #${item.prNumber}: ${item.libraryName} ${item.currentVersion} → ${fix} [${item.upgradeType}]`);
        console.log(`         ${item.justification}`);
        if (item.alternative) console.log(`         Alternative: ${item.alternative}`);
      }
    }
    const groupPRs  = notFound.filter(n => n.isMonorepoGroup || n.isPackageGroup);
    const regularNF = notFound.filter(n => !n.isMonorepoGroup && !n.isPackageGroup);

    if (groupPRs.length > 0) {
      console.log(`\n  Group PRs (no direct package match — manual review required):`);
      for (const nf of groupPRs) {
        const kind = nf.isMonorepoGroup ? 'monorepo group' : 'packages group';
        const ver  = nf.proposedVersion ? ` → ${nf.proposedVersion}` : '';
        console.log(`    PR #${nf.prNumber}: ${nf.packageName} ${kind}${ver}`);
      }
    }
    if (regularNF.length > 0) {
      console.log(`\n  Not found in this repo:`);
      for (const nf of regularNF) {
        console.log(`    PR #${nf.prNumber}: ${nf.packageName} → ${nf.proposedVersion}`);
      }
    }
    console.log(`\n  ${bar}`);
  }

  // 8. Write output (and optionally apply)
  const outDir = resolveOutDir(args, repoName, repoDir);
  const result = await writeOutputRenovate({
    phasedItems, pkg, repoDir, packageJsonPath, lockFilePath,
    outDir, apply: args.apply, dryRun: args.dryRun,
    repoName, org, runDate, depTree, notFound,
  });

  // 9. Close Phase A PRs (if --close-prs and changes were applied)
  if (args.closePRs && args.githubToken && result.applied && !args.dryRun) {
    for (const item of result.phaseA) {
      if (!item.prNumber) continue;
      const type = item._directUpgrade ? 'direct dep bump' : 'override';
      const comment = [
        `This upgrade was analyzed and applied by the mendfix Renovate workflow.`,
        ``,
        `Package: ${item.libraryName} ${item.currentVersion} -> ${item.recommendedVersion}`,
        `Type: Phase A (safe same-major upgrade — applied as ${type})`,
        ``,
        `This PR has been closed automatically. The change is part of a batch mendfix commit.`,
      ].join('\n');

      const commentResult = await postComment(org, repoName, item.prNumber, args.githubToken, comment);
      if (!commentResult.ok) {
        errors.push(`Failed to comment on PR #${item.prNumber}: HTTP ${commentResult.status}`);
      }
      const closeResult = await closePR(org, repoName, item.prNumber, args.githubToken);
      if (closeResult.ok) {
        console.log(`  Closed PR #${item.prNumber} (${item.libraryName})`);
      } else {
        errors.push(`Failed to close PR #${item.prNumber}: HTTP ${closeResult.status}`);
      }
    }
  } else if (args.closePRs && args.dryRun) {
    for (const item of result.phaseA) {
      if (item.prNumber) console.log(`  [dry-run] Would close PR #${item.prNumber} (${item.libraryName})`);
    }
  }

  result.errors.push(...errors);
  return { repoName, org, outDir, ...result };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv !== undefined ? argv : process.argv.slice(2));

  if (!args.config) {
    console.error('Error: --config <repos.json> is required');
    printUsage();
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (err) {
    console.error(`Error reading config: ${err.message}`);
    process.exit(1);
  }

  const org   = config.org   || 'riversandtechnologies';
  const repos = config.repos || [];

  if (repos.length === 0) {
    console.error('Error: no repos defined in config');
    process.exit(1);
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const flags = [
    args.apply          ? '--apply'                          : null,
    args.verifyVersions ? '--verify-versions'                : null,
    args.closePRs       ? '--close-prs'                      : null,
    args.dryRun         ? '--dry-run'                        : null,
    args.includePRs     ? `--include-prs ${args.includePRs}` : null,
    args.excludePRs     ? `--exclude-prs ${args.excludePRs}` : null,
  ].filter(Boolean).join(' ');

  console.log(`Renovate workflow — ${repos.length} repo(s) under org: ${org}`);
  if (flags) console.log(`Flags: ${flags}`);

  const results = [];
  for (const repoConfig of repos) {
    const result = await processRepo(repoConfig, org, args, runDate);
    results.push(result);
    if (result.outDir) console.log(`  Report: ${result.outDir}/renovate-report.md`);
  }

  console.log('\n--- Summary ---');
  for (const r of results) {
    const a = r.phaseA ? r.phaseA.length : '-';
    const b = r.phaseB ? r.phaseB.length : '-';
    const c = r.phaseC ? r.phaseC.length : '-';
    const nf = r.notFound ? r.notFound.length : '-';
    const applied = r.applied ? 'applied' : (args.apply ? 'failed' : 'not applied');
    console.log(`${r.org}/${r.repoName}: A:${a} B:${b} C:${c} NotFound:${nf} | ${applied}`);
    if (r.errors && r.errors.length > 0) {
      for (const e of r.errors) console.error(`  ERROR: ${e}`);
    }
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
