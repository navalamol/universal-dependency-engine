'use strict';

const fs   = require('fs');
const path = require('path');

const { detectProvider, getParser }          = require('./src/providers/index');
const { buildResolutionPlan }                = require('./src/core/semver-engine');
const { applyPhases }                        = require('./src/core/phases');
const { enrichWithConfidence }               = require('./src/core/confidence');
const { enrichWithPaths }                    = require('./src/core/remediation-paths');
const { detectEcosystem }                    = require('./src/ecosystems/index');
const { parseLockFile, getRootDeps }         = require('./src/ecosystems/npm/lock-parser');
const { verifyPlanVersions: verifyNpm }      = require('./src/ecosystems/npm/registry');
const { verifyPlanVersions: verifyMaven }    = require('./src/ecosystems/maven/registry');
const { verifyPlanVersions: verifyPython }   = require('./src/ecosystems/python/registry');
const { verifyPlanVersions: verifyGo }       = require('./src/ecosystems/go/registry');
const { verifyPlanVersions: verifyDotnet }   = require('./src/ecosystems/dotnet/registry');
const { verifyPlanVersions: verifyRust }     = require('./src/ecosystems/rust/registry');

const REGISTRY_VERIFIERS = { npm: verifyNpm, maven: verifyMaven, python: verifyPython, go: verifyGo, dotnet: verifyDotnet, rust: verifyRust };
const SEVERITY_ORDER      = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];

// ---------------------------------------------------------------------------
// Config loader + validator
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in portfolio config: ${e.message}`); }

  if (!Array.isArray(cfg.repos)) {
    throw new Error('Portfolio config must have a "repos" array');
  }
  for (const repo of cfg.repos) {
    if (!repo.name)   throw new Error('Each repo entry must have a "name" field');
    if (!repo.report) throw new Error(`Repo "${repo.name}" is missing a "report" field`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Per-repo analysis
// ---------------------------------------------------------------------------

async function analyzeRepo(repoEntry, globalOpts = {}) {
  const { name } = repoEntry;
  const verifyVersions = repoEntry.verifyVersions !== undefined
    ? repoEntry.verifyVersions
    : (globalOpts.verifyVersions || false);

  const result = {
    name,
    ecosystem:      null,
    provider:       null,
    status:         'ok',
    error:          null,
    totalLibraries: 0,
    totalCves:      0,
    phaseA:         [],
    phaseB:         [],
    phaseC:         [],
    highestSeverity: 'NONE',
    criticalCount:  0,
    highCount:      0,
    mediumCount:    0,
    lowCount:       0,
    outDir:         null,
  };

  try {
    const provider = repoEntry.provider || detectProvider(repoEntry.report);
    result.provider = provider;
    const entries = getParser(provider).parseReport(repoEntry.report);
    result.totalLibraries = entries.length;
    result.totalCves      = entries.reduce((n, e) => n + e.cves.length, 0);

    const ecosystem = detectEcosystem(entries, repoEntry.ecosystem || null);
    result.ecosystem = ecosystem;

    // Lock file (npm only)
    let depTree  = null;
    let rootDeps = null;
    if (ecosystem === 'npm' && repoEntry.lockFile && fs.existsSync(repoEntry.lockFile)) {
      depTree  = parseLockFile(repoEntry.lockFile);
      rootDeps = getRootDeps(repoEntry.lockFile);
    }

    // SemVer resolution
    let plan = buildResolutionPlan(entries);

    // Optional registry verification
    if (verifyVersions) {
      const verifyFn = REGISTRY_VERIFIERS[ecosystem];
      if (verifyFn) plan = await verifyFn(plan);
    }

    // Phase classification + enrichment
    let phasedPlan = applyPhases(plan, depTree, rootDeps);
    phasedPlan     = enrichWithConfidence(phasedPlan, depTree);
    phasedPlan     = enrichWithPaths(phasedPlan, entries);

    result.phaseA = phasedPlan.filter(r => r.phase === 'A');
    result.phaseB = phasedPlan.filter(r => r.phase === 'B');
    result.phaseC = phasedPlan.filter(r => r.phase === 'C');

    // Severity aggregation
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const item of phasedPlan) {
      for (const cve of (item.cves || [])) {
        const sev = (cve.severity || '').toUpperCase();
        if (sev in counts) counts[sev]++;
      }
    }
    result.criticalCount = counts.CRITICAL;
    result.highCount     = counts.HIGH;
    result.mediumCount   = counts.MEDIUM;
    result.lowCount      = counts.LOW;
    result.highestSeverity = SEVERITY_ORDER.find(s => counts[s] > 0) || 'NONE';

  } catch (err) {
    result.status = 'error';
    result.error  = err.message;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Portfolio orchestrator
// ---------------------------------------------------------------------------

async function runPortfolio(configPath, opts = {}) {
  const cfg        = loadConfig(configPath);
  const globalOpts = {
    verifyVersions:  cfg.verifyVersions  || opts.verifyVersions  || false,
    maxDepth:        cfg.maxDepth        || opts.maxDepth,
    maxSimulations:  cfg.maxSimulations  || opts.maxSimulations,
  };
  const outDir = opts.outDir || cfg.outDir
    || path.join(path.dirname(path.resolve(configPath)), 'portfolio-output');

  const repos = [];
  for (const repoEntry of cfg.repos) {
    const repoResult = await analyzeRepo(repoEntry, globalOpts);
    repoResult.outDir = path.join(outDir, repoEntry.name.replace(/[/\\:]/g, '_'));
    repos.push(repoResult);
  }

  return {
    repos,
    totalRepos:      repos.length,
    totalCves:       repos.reduce((n, r) => n + r.totalCves, 0),
    totalLibraries:  repos.reduce((n, r) => n + r.totalLibraries, 0),
    totalPhaseA:     repos.reduce((n, r) => n + r.phaseA.length, 0),
    totalPhaseB:     repos.reduce((n, r) => n + r.phaseB.length, 0),
    totalPhaseC:     repos.reduce((n, r) => n + r.phaseC.length, 0),
    criticalCount:   repos.reduce((n, r) => n + r.criticalCount, 0),
    highCount:       repos.reduce((n, r) => n + r.highCount, 0),
    mediumCount:     repos.reduce((n, r) => n + r.mediumCount, 0),
    lowCount:        repos.reduce((n, r) => n + r.lowCount, 0),
    errorCount:      repos.filter(r => r.status === 'error').length,
    runDate:         new Date().toISOString().split('T')[0],
    outDir,
  };
}

module.exports = { loadConfig, analyzeRepo, runPortfolio };
