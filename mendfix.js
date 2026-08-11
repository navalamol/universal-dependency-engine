#!/usr/bin/env node
'use strict';

if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Error: Node.js 18 or higher is required (running ${process.versions.node})`);
  process.exit(1);
}

const fs   = require('fs');
const path = require('path');
const semver = require('semver');

const { detectProvider, getParser }                      = require('./src/providers/index');

function parseReport(reportPath) {
  const provider = detectProvider(reportPath);
  return getParser(provider).parseReport(reportPath);
}
const { buildResolutionPlan }                            = require('./src/core/semver-engine');
const { applyPhases, PHASE_META }                        = require('./src/core/phases');
const { verifyPlanVersions: verifyNpm }                  = require('./src/ecosystems/npm/registry');
const { verifyPlanVersions: verifyMaven }                = require('./src/ecosystems/maven/registry');
const { buildPhaseAOverrides, buildPhaseBOverrides,
        applyOverridesToPackageJson, writeOverridesPatch,
        detectDirectDeps, applyDirectUpgrades }            = require('./src/ecosystems/npm/overrides');
const { snapshotFiles, restoreFiles, runPackageLockUpdate, runMavenResolve,
        verifyFixVersions, saveManifest,
        detectManualChanges }                              = require('./src/ecosystems/npm/installer');
const { writePomPatch, applyPomPatch,
        detectManualChanges: detectMavenChanges }          = require('./src/ecosystems/maven/pom-writer');
const { generateReport }                                 = require('./src/core/report');
const { generatePRDescription }                          = require('./src/core/pr-description');
const { parseLockFile, getRootDeps, findDepChain }       = require('./src/ecosystems/npm/lock-parser');
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
  mendfix analyze  --report <path> [options]          (dry run — no files changed)
  mendfix apply    --report <path> [options]          (apply Phase A, write output)
  mendfix cleanup  --package-json <path> --lock-file <path>   (remove stale overrides)
  mendfix renovate --config <repos.json> [options]    (analyze/apply Renovate PRs across repos)

  # Legacy flag-based syntax still works:
  node mendfix.js --report <path> [--dry-run] [--package-json <path>] ...

Required (analyze / apply):
  --report <path>            Mend vulnerability report (.json or .xlsx)

Options:
  --package-json <path>      (npm) Apply Phase A overrides directly to this file
  --pom-xml <path>           (maven) Apply Phase A <dependencyManagement> entries to this file
  --lock-file <path>         (npm) package-lock.json for dep-tree features
                             Enables: consumer range validation, dev classification,
                             parent upgrade recommendations
  --ecosystem <npm|maven>    Override auto-detected ecosystem
  --out-dir <path>           Output directory  [default: ./mend-output]
  --verify-versions          Check registry to confirm versions exist
  --dry-run                  Print plan to stdout; write nothing to disk

Phase output files written to --out-dir:
  npm:   phase-a-overrides.json / phase-b-overrides.json / manual-review.md
  maven: phase-a-pom-patch.xml / phase-b-pom-patch.xml / manual-review.md
         remediation-report.md  (all ecosystems)

Examples:
  mendfix analyze  --report vuln-report.json
  mendfix analyze  --report vuln-report.json --verify-versions
  mendfix apply    --report npm-report.json \\
    --package-json ../ui-platform/package.json \\
    --lock-file    ../ui-platform/package-lock.json \\
    --verify-versions
  mendfix apply    --report maven-report.json \\
    --pom-xml ../dataplatform/pom.xml \\
    --verify-versions
  mendfix cleanup  --package-json ../ui-platform/package.json \\
    --lock-file ../ui-platform/package-lock.json
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

async function runCleanup(lockFilePath, packageJsonPath) {
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── Subcommand routing ───────────────────────────────────────────────────
  const rawArgs = process.argv.slice(2);
  const SUBCMDS = ['analyze', 'apply', 'cleanup', 'renovate'];
  const subcmd  = SUBCMDS.includes(rawArgs[0]) ? rawArgs.shift() : null;

  if (subcmd === 'renovate') {
    const { main: renovateMain } = require('./renovate-apply');
    await renovateMain(rawArgs);
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
    await runCleanup(lf, args['package-json'] || null);
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

  const reportFile      = args.report;
  const packageJsonPath = args['package-json'] || null;
  const pomXmlPath      = args['pom-xml'] || null;
  const lockFilePath    = args['lock-file'] || null;
  const outDir          = args['out-dir'] || path.join(path.dirname(path.resolve(reportFile)), 'mend-output');
  const verifyVersions  = args['verify-versions'] === true;
  const dryRun          = args['dry-run'] === true;
  const autoCommit      = args['commit'] === true;

  const mode = subcmd ? subcmd.toUpperCase() : (dryRun ? 'ANALYZE' : 'APPLY');
  console.log(`\nMend AutoFixer [${mode}]`);
  console.log('='.repeat(16 + mode.length));
  console.log(`Report  : ${reportFile}`);
  if (packageJsonPath) console.log(`Target  : ${packageJsonPath}`);
  if (pomXmlPath)      console.log(`POM     : ${pomXmlPath}`);
  if (lockFilePath)    console.log(`Lock    : ${lockFilePath}`);
  if (!dryRun)         console.log(`Out dir : ${outDir}`);

  // ── Step 1: Parse report ─────────────────────────────────────────────────
  console.log('\n[1/5] Parsing vulnerability report...');
  let entries;
  try {
    entries = parseReport(reportFile);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }

  const totalCves = entries.reduce((n, e) => n + e.cves.length, 0);
  console.log(`  ${noun(entries.length, 'unique library', 'unique libraries')} with vulnerabilities`);
  console.log(`  ${totalCves} total CVEs`);

  const ecosystem = detectEcosystem(entries, args.ecosystem);
  console.log(`  Ecosystem: ${ecosystem}`);
  if (verifyVersions) console.log(`  Registry: ${ecosystem === 'maven' ? 'Maven Central' : 'npm'} verification enabled`);

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
  } else {
    // Maven — run mvn dependency:tree if a project directory can be inferred
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
  }

  // ── Step 2: Resolve fix versions ─────────────────────────────────────────
  console.log('\n[2/5] Resolving fix versions (SemVer)...');
  let plan = buildResolutionPlan(entries);

  // ── Step 3: Optional registry verification ───────────────────────────────
  if (verifyVersions) {
    if (ecosystem === 'maven') {
      console.log('\n[3/5] Verifying versions against Maven Central...');
      plan = await verifyMaven(plan);
    } else {
      console.log('\n[3/5] Verifying versions against npm registry...');
      plan = await verifyNpm(plan);
    }

    for (const item of plan) {
      if (item.registryExists === false && item.phase !== 'C') {
        console.log(`  ⚠  ${item.libraryName}: ${item.recommendedVersion} not found on ${ecosystem === 'maven' ? 'Maven Central' : 'npm'} — escalating to Phase C`);
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
  const phasedPlan = applyPhases(plan, depTree);

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
    }
  }

  const phaseA = phasedPlan.filter(r => r.phase === 'A');
  const phaseB = phasedPlan.filter(r => r.phase === 'B');
  const phaseC = phasedPlan.filter(r => r.phase === 'C');

  printPhaseRow('✅', 'A', phaseA);
  printPhaseRow('⚠️ ', 'B', phaseB);
  printPhaseRow('❌', 'C', phaseC);

  console.log('');
  for (const r of phaseA) console.log(`  ✅ ${r.libraryName}: ${r.currentVersion} → ${r.recommendedVersion}`);
  for (const r of phaseB) console.log(`  ⚠️  ${r.libraryName}: ${r.currentVersion} → ${r.recommendedVersion}`);
  for (const r of phaseC) {
    const fix = r.recommendedVersion || 'NO FIX';
    const fp  = r.probableFalsePositive ? ' [PROBABLE FALSE POSITIVE]' : '';
    console.log(`  ❌ ${r.libraryName}: ${r.currentVersion} → ${fix}  [${r.upgradeType}]${fp}`);
  }

  // ── Step 5: Write output ─────────────────────────────────────────────────
  console.log('\n[5/5] Writing output...');

  const reportContent = generateReport(phasedPlan, {
    project:        path.basename(reportFile, path.extname(reportFile)),
    reportDate:     new Date().toISOString().split('T')[0],
    verifyVersions,
    ecosystem,
  });

  if (dryRun) {
    console.log('\n' + '─'.repeat(70));
    console.log(reportContent);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  let applyFailed;
  if (ecosystem === 'maven') {
    applyFailed = await writeOutputMaven(phasedPlan, phaseA, phaseB, phaseC, outDir, pomXmlPath, reportContent);
  } else {
    applyFailed = await writeOutputNpm(phasedPlan, phaseA, phaseB, phaseC, outDir, packageJsonPath, depTree, reportContent, verifyVersions);
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

  // Scenarios 15/16: auto-commit after successful apply
  if (autoCommit && phaseA.length > 0) {
    const { commitPhaseA, commitPhaseBC, commitFalsePositives } = require('./src/core/git-commits');
    const projectDir = packageJsonPath ? path.dirname(packageJsonPath) : process.cwd();
    console.log('\nCommitting...');
    const commitResult = await commitPhaseA(projectDir, phaseA, ecosystem);
    if (commitResult.success) {
      console.log(`  Committed Phase A fixes: ${commitResult.message.split('\n')[0]}`);
    } else {
      console.warn(`  Warning: git commit failed: ${commitResult.message}`);
    }
    const phaseBC = [...phaseB, ...phaseC.filter(i => !i.probableFalsePositive)];
    const falsePositives = phaseC.filter(i => i.probableFalsePositive);
    if (phaseBC.length > 0) {
      const bcResult = commitPhaseBC(projectDir, phaseB, phaseC.filter(i => !i.probableFalsePositive));
      if (!bcResult.success) console.warn(`  Warning: Phase B/C commit failed: ${bcResult.message}`);
    }
    if (falsePositives.length > 0) {
      const fpResult = commitFalsePositives(projectDir, falsePositives);
      if (!fpResult.success) console.warn(`  Warning: false-positive commit failed: ${fpResult.message}`);
    }
  }

  console.log('\nDone.');
  printNextSteps(ecosystem, outDir, packageJsonPath, pomXmlPath, phaseA, phaseB, phaseC);
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

async function writeOutputNpm(phasedPlan, phaseA, phaseB, phaseC, outDir, packageJsonPath, depTree, reportContent, verifyVersions) {
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

  if (phaseC.length > 0) {
    const manualPath = path.join(outDir, 'manual-review.md');
    fs.writeFileSync(manualPath, buildManualReview(phaseC, 'npm'));
    console.log(`  Wrote: ${manualPath}`);
  }

  const reportPath = path.join(outDir, 'remediation-report.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`  Wrote: ${reportPath}`);

  if (!packageJsonPath) return;
  if (!fs.existsSync(packageJsonPath)) {
    console.warn(`  WARN: ${packageJsonPath} not found — skipping auto-apply`);
    return;
  }
  if (directUpgrades.length === 0 && Object.keys(phaseAOverrides).length === 0) {
    console.log(`  No Phase A fixes to apply to ${packageJsonPath}`);
    return;
  }

  // Idempotency check (Scenario 21)
  if (isAlreadyApplied(packageJsonPath, phaseAOverrides, directUpgrades)) {
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
        console.log(`  Override    : ${k} → ${v}`);
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

    const verifyItems = [
      ...directUpgrades,
      ...phaseAForOverrides.filter(i => cleanOverrides[i.libraryName]),
    ];
    if (fs.existsSync(installLockPath) && verifyItems.length > 0) {
      const failures = verifyFixVersions(installLockPath, verifyItems);
      if (failures.length > 0) {
        console.error(`\n  ✗  Post-install verification FAILED — rolling back:`);
        for (const f of failures) {
          console.error(`     ${f.libraryName}: expected >=${f.expected}, got [${f.resolved.join(', ') || 'not found'}]`);
        }
        restoreFiles(snapshots);
        console.log(`  Rolled back. No files changed.`);
        process.exitCode = 1;
        return true;
      }
      console.log(`  Verified: all ${verifyItems.length} package(s) at fix version in lock file.`);
    }

    const directMap = {};
    for (const u of directUpgrades) directMap[u.libraryName] = u.recommendedVersion;
    saveManifest(packageJsonPath, cleanOverrides, directMap);
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
// Next-steps summary
// ---------------------------------------------------------------------------

function printNextSteps(ecosystem, outDir, packageJsonPath, pomXmlPath, phaseA, phaseB, phaseC) {
  const targetApplied = ecosystem === 'maven' ? pomXmlPath : packageJsonPath;
  const hasNextSteps  = !targetApplied || phaseB.length > 0 || phaseC.length > 0;
  if (!hasNextSteps) return;

  console.log('\nNext steps:');
  let step = 1;

  if (!targetApplied && phaseA.length > 0) {
    if (ecosystem === 'maven') {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-pom-patch.xml')}`);
      console.log(`  ${step++}. Add the <dependencyManagement> entries to your pom.xml`);
      console.log(`  ${step++}. Run: mvn dependency:resolve`);
    } else {
      console.log(`  ${step++}. Review ${path.join(outDir, 'phase-a-overrides.json')}`);
      console.log(`  ${step++}. Merge Phase A overrides into your project's package.json`);
      console.log(`  ${step++}. Run: npm install --package-lock-only --legacy-peer-deps`);
    }
  }

  if (phaseB.length > 0) {
    const patchFile = ecosystem === 'maven'
      ? path.join(outDir, 'phase-b-pom-patch.xml')
      : path.join(outDir, 'phase-b-overrides.json');
    console.log(`  ${step++}. Review ${patchFile} — test before applying`);
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
        lines.push(`- [ ] Check if upgrading ${parentNames} to a newer major ships \`${r.libraryName}\` at a patched version (preferred over adding an override)`);
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
