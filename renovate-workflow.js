#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseReport }       = require('./src/providers/mend');
const { buildResolutionPlan } = require('./src/core/semver-engine');
const { applyPhases }       = require('./src/core/phases');
const { parseLockFile }     = require('./src/ecosystems/npm/lock-parser');
const { verifyPlanVersions } = require('./src/ecosystems/npm/registry');
const { fetchRenovatePRs, postComment, closePR } = require('./src/providers/github');
const { classifyPRs, summarize, buildCloseComment, CATEGORIES } = require('./src/core/renovate-classifier');
const { writeReport } = require('./src/core/renovate-report');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    config: null,
    githubToken: process.env.GITHUB_TOKEN || null,
    cloneDir: './repos',
    outDir: './renovate-output',
    closePRs: false,
    dryRun: false,
    verifyVersions: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config')          args.config = argv[++i];
    else if (a === '--github-token') args.githubToken = argv[++i];
    else if (a === '--clone-dir')  args.cloneDir = argv[++i];
    else if (a === '--out-dir')    args.outDir = argv[++i];
    else if (a === '--close-prs')  args.closePRs = true;
    else if (a === '--dry-run')    args.dryRun = true;
    else if (a === '--verify-versions') args.verifyVersions = true;
    else if (a === '--help') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: node renovate-workflow.js --config <repos.json> [options]

Options:
  --config <path>         Path to repos config JSON (required)
  --github-token <token>  GitHub token (or set GITHUB_TOKEN env var)
  --clone-dir <path>      Directory to clone repos into (default: ./repos)
  --out-dir <path>        Output directory for reports (default: ./renovate-output)
  --close-prs             Close COVERED_PHASE_A and COVERED_PHASE_B PRs with a comment
  --dry-run               Print actions without closing any PRs
  --verify-versions       Check npm registry to confirm fix versions exist
  --help                  Print this message

repos.json format:
  {
    "org": "navalamol",
    "repos": [
      { "name": "ui-platform", "report": "./input/reports/GH_ui-platform.json" },
      { "name": "ui-platform-elements", "report": "./input/reports/GH_ui-platform-elements.json" }
    ]
  }
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

  if (fs.existsSync(targetDir)) {
    console.log(`  Pulling latest ${repoName}...`);
    const result = spawnSync('git', ['-C', targetDir, 'pull', '--ff-only'], { encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) {
      console.warn(`  Warning: git pull failed for ${repoName}: ${result.stderr}`);
    }
  } else {
    console.log(`  Cloning ${org}/${repoName}...`);
    if (!fs.existsSync(cloneDir)) fs.mkdirSync(cloneDir, { recursive: true });
    const result = spawnSync('git', ['clone', '--depth=1', repoUrl, targetDir], { encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) {
      throw new Error(`git clone failed for ${repoName}: ${result.stderr}`);
    }
  }

  return targetDir;
}

// ---------------------------------------------------------------------------
// mendfix pipeline (inline, no spawn)
// ---------------------------------------------------------------------------

async function runMendfixAnalyze(reportPath, verifyVersions, repoDir) {
  const entries = parseReport(reportPath);
  let plan = buildResolutionPlan(entries);

  if (verifyVersions) {
    plan = await verifyPlanVersions(plan);
  }

  // Parse lock file for dep-tree enrichment if the cloned repo is available
  let depTree = null;
  if (repoDir) {
    const lockPath = path.join(repoDir, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      try {
        depTree = parseLockFile(lockPath);
      } catch {
        console.warn(`  Warning: could not parse lock file at ${lockPath} — running without dep-tree enrichment`);
      }
    }
  }

  const phased = applyPhases(plan, depTree);
  return phased;
}

// ---------------------------------------------------------------------------
// Per-repo processing
// ---------------------------------------------------------------------------

async function processRepo(repoConfig, org, args) {
  const { name: repoName, report: reportPath } = repoConfig;
  console.log(`\n[${repoName}]`);

  const errors = [];
  let clonedDir = null;
  let phasedItems = [];
  let renovatePRs = [];
  let classifiedPRs = [];

  // 1. Clone / pull
  try {
    clonedDir = cloneOrPull(org, repoName, args.cloneDir, args.githubToken);
  } catch (err) {
    errors.push(`Clone failed: ${err.message}`);
    console.error(`  Clone failed: ${err.message}`);
  }

  // 2. Run mendfix pipeline
  const resolvedReport = path.resolve(reportPath);
  if (!fs.existsSync(resolvedReport)) {
    errors.push(`Mend report not found: ${resolvedReport}`);
    console.error(`  Mend report not found: ${resolvedReport}`);
  } else {
    try {
      console.log(`  Running mendfix analysis...`);
      phasedItems = await runMendfixAnalyze(resolvedReport, args.verifyVersions, clonedDir);
      console.log(`  Phase A: ${phasedItems.filter(i => i.phase === 'A').length}  B: ${phasedItems.filter(i => i.phase === 'B').length}  C: ${phasedItems.filter(i => i.phase === 'C').length}`);
    } catch (err) {
      errors.push(`mendfix analysis failed: ${err.message}`);
      console.error(`  mendfix analysis failed: ${err.message}`);
    }
  }

  // 3. Fetch Renovate PRs
  if (!args.githubToken) {
    errors.push('No GitHub token provided — skipping PR fetch');
    console.warn('  No GitHub token — skipping PR fetch');
  } else {
    try {
      console.log(`  Fetching Renovate PRs...`);
      renovatePRs = await fetchRenovatePRs(org, repoName, args.githubToken);
      console.log(`  Found ${renovatePRs.length} open Renovate PR(s)`);
    } catch (err) {
      errors.push(`GitHub PR fetch failed: ${err.message}`);
      console.error(`  GitHub PR fetch failed: ${err.message}`);
    }
  }

  // 4. Classify PRs
  classifiedPRs = classifyPRs(renovatePRs, phasedItems);

  // 5. Act on PRs (close with comment)
  const shouldAct = args.closePRs && args.githubToken;
  const closeable = new Set([CATEGORIES.COVERED_PHASE_A, CATEGORIES.COVERED_PHASE_B]);
  const commentOnly = new Set([CATEGORIES.DISCARDED_MAJOR_BUMP]);

  for (const classified of classifiedPRs) {
    const { pr, category } = classified;

    if (closeable.has(category)) {
      const comment = buildCloseComment(classified);
      if (args.dryRun) {
        console.log(`  [dry-run] Would close PR #${pr.number}: ${pr.title}`);
        classified.actionTaken = 'dry-run: would close';
      } else if (shouldAct) {
        console.log(`  Closing PR #${pr.number} (${category})...`);
        const commentResult = await postComment(org, repoName, pr.number, args.githubToken, comment);
        if (!commentResult.ok) {
          errors.push(`Failed to comment on PR #${pr.number}: status ${commentResult.status}`);
        }
        const closeResult = await closePR(org, repoName, pr.number, args.githubToken);
        if (closeResult.ok) {
          classified.actionTaken = 'closed with comment';
        } else {
          errors.push(`Failed to close PR #${pr.number}: status ${closeResult.status}`);
          classified.actionTaken = 'close failed';
        }
      }
    } else if (commentOnly.has(category) && shouldAct && !args.dryRun) {
      // For major bumps: leave PR open but post an informational comment
      const comment = buildCloseComment(classified);
      if (comment) {
        const commentResult = await postComment(org, repoName, pr.number, args.githubToken, comment);
        classified.actionTaken = commentResult.ok ? 'commented (not closed)' : 'comment failed';
      }
    }
  }

  const stats = summarize(classifiedPRs);

  return { repoName, org, reportPath, phasedItems, classifiedPRs, stats, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  const org = config.org || 'navalamol';
  const repos = config.repos || [];

  if (repos.length === 0) {
    console.error('Error: no repos defined in config');
    process.exit(1);
  }

  if (args.dryRun) console.log('[dry-run mode — no PRs will be closed]');
  console.log(`Processing ${repos.length} repo(s) under org: ${org}`);

  const repoResults = [];

  for (const repoConfig of repos) {
    const result = await processRepo(repoConfig, org, args);
    repoResults.push(result);

    const s = result.stats;
    console.log(
      `  -> ${s.total} PRs | Covered A:${s.coveredA} B:${s.coveredB} | MajorBump:${s.majorBump} MultiMajor:${s.multiMajor} NoFix:${s.noFix} | Insufficient:${s.insufficient} | OutOfScope:${s.notInReport}`
    );
  }

  const runDate = new Date().toISOString().slice(0, 10);
  writeReport(repoResults, path.resolve(args.outDir), runDate);

  const mdPath = path.resolve(args.outDir, 'renovate-workflow-report.md');
  const jsonPath = path.resolve(args.outDir, 'renovate-workflow-report.json');
  console.log(`\nReport written:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);

  // Print summary table
  console.log('\n--- Summary ---');
  for (const r of repoResults) {
    const s = r.stats;
    console.log(`${r.org}/${r.repoName}: ${s.total} PRs | A:${s.coveredA} B:${s.coveredB} Bump:${s.majorBump} Multi:${s.multiMajor} NoFix:${s.noFix} Insuff:${s.insufficient} OOS:${s.notInReport}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
