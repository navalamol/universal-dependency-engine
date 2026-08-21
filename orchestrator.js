'use strict';

/**
 * Canonical analysis pipeline consumed by CLI, VS Code extension, and portfolio mode.
 * Any entry point that produces phase classifications MUST use this module.
 *
 * Pipeline order:
 *   1. parseReport        → LibraryEntry[]
 *   2. detectEcosystem    → 'npm'|'maven'|'python'|'go'|'dotnet'|'rust'
 *   3. loadDepTree        → { depTree, rootDeps }   (ecosystem-specific)
 *   4. buildResolutionPlan → ResolutionItem[]
 *   5. verifyPlanVersions  (optional, ecosystem-specific)
 *   6. applyPhases         → PhasedItem[]
 *   6.5. Phase-C escalation for versions missing from registry
 *   7. npm rootParents + depChain enrichment   (npm + depTree only)
 *   7b. exploreParentUpgrades                 (npm + verifyVersions only)
 *   8. enrichWithConfidence
 *   9. enrichWithPaths
 *
 * Returns: { entries, ecosystem, provider, phasedPlan, registryAdjustments }
 */

const fs   = require('fs');
const path = require('path');

const { detectProvider, getParser }                         = require('./src/providers/index');
const { buildResolutionPlan }                               = require('./src/core/semver-engine');
const { applyPhases }                                       = require('./src/core/phases');
const { enrichWithConfidence }                              = require('./src/core/confidence');
const { enrichWithPaths }                                   = require('./src/core/remediation-paths');
const { classifyPlanExposure }                              = require('./src/core/exposure-classifier');
const { mergeExposureClassification }                       = require('./src/core/evidence-model');
const { detectEcosystem }                                   = require('./src/ecosystems/index');
const { parseLockFile: parseNpmLock, getRootDeps, findDepChain } =
  require('./src/ecosystems/npm/lock-parser');

// ---------------------------------------------------------------------------
// Registry verifier lookup (lazy-loaded to avoid loading all ecosystems)
// ---------------------------------------------------------------------------

const REGISTRY_VERIFIERS = {
  npm:    () => require('./src/ecosystems/npm/registry').verifyPlanVersions,
  maven:  () => require('./src/ecosystems/maven/registry').verifyPlanVersions,
  python: () => require('./src/ecosystems/python/registry').verifyPlanVersions,
  go:     () => require('./src/ecosystems/go/registry').verifyPlanVersions,
  dotnet: () => require('./src/ecosystems/dotnet/registry').verifyPlanVersions,
  rust:   () => require('./src/ecosystems/rust/registry').verifyPlanVersions,
};

// ---------------------------------------------------------------------------
// Dep-tree loader (ecosystem-specific, errors are non-fatal)
// ---------------------------------------------------------------------------

function loadDepTree(ecosystem, opts) {
  const {
    reportPath, lockFilePath, pomXmlPath,
    requirementsTxtPath, goModPath, packagesPropsPath, cargoTomlPath,
  } = opts;

  let depTree  = null;
  let rootDeps = null;

  try {
    if (ecosystem === 'npm') {
      if (lockFilePath && fs.existsSync(lockFilePath)) {
        depTree  = parseNpmLock(lockFilePath);
        rootDeps = getRootDeps(lockFilePath);
      }
    } else if (ecosystem === 'maven') {
      if (pomXmlPath) {
        const { buildMavenDepTree } = require('./src/ecosystems/maven/dep-tree');
        depTree = buildMavenDepTree(path.dirname(pomXmlPath));
      }
    } else if (ecosystem === 'python') {
      const { parseLockFile: parsePyLock, detectLockFile } =
        require('./src/ecosystems/python/lock-parser');
      const baseDir   = reportPath ? path.dirname(path.resolve(reportPath)) : process.cwd();
      const candidate = requirementsTxtPath || detectLockFile(baseDir);
      if (candidate && fs.existsSync(candidate)) {
        depTree = parsePyLock(candidate);
      }
    } else if (ecosystem === 'go') {
      if (goModPath && fs.existsSync(goModPath)) {
        depTree = require('./src/ecosystems/go/lock-parser').parseLockFile(goModPath);
      }
    } else if (ecosystem === 'dotnet') {
      const { parseLockFile: parseDotnetLock, detectLockFile: detectDotnetLock } =
        require('./src/ecosystems/dotnet/lock-parser');
      const baseDir   = reportPath ? path.dirname(path.resolve(reportPath)) : process.cwd();
      const candidate = packagesPropsPath || detectDotnetLock(baseDir);
      if (candidate && fs.existsSync(candidate)) {
        depTree = parseDotnetLock(candidate);
      }
    } else if (ecosystem === 'rust') {
      const cargoLockPath = cargoTomlPath
        ? path.join(path.dirname(cargoTomlPath), 'Cargo.lock')
        : null;
      const candidate = (cargoLockPath && fs.existsSync(cargoLockPath)) ? cargoLockPath
        : (cargoTomlPath && fs.existsSync(cargoTomlPath)) ? cargoTomlPath
        : null;
      if (candidate) {
        depTree = require('./src/ecosystems/rust/lock-parser').parseLockFile(candidate);
      }
    }
  } catch {
    // dep-tree is optional — pipeline continues without it
    depTree  = null;
    rootDeps = null;
  }

  return { depTree, rootDeps };
}

// ---------------------------------------------------------------------------
// npm Phase-C rootParents + depChain enrichment
// ---------------------------------------------------------------------------

function enrichNpmChains(phasedPlan, depTree, rootDeps) {
  if (!depTree || !rootDeps) return;
  const allRootDeps = { ...rootDeps.dependencies, ...rootDeps.devDependencies };

  for (const item of phasedPlan) {
    if (item.phase !== 'C') continue;

    if (item.upgradeType === 'MAJOR_BUMP') {
      const treeEntries = depTree.get(item.libraryName) || [];
      const allParents  = new Set(treeEntries.flatMap(e => e.parents.map(p => p.name)));
      item.rootParents  = [...allParents]
        .filter(name => allRootDeps[name])
        .map(name => ({
          name,
          range: allRootDeps[name],
          isDev: !!rootDeps.devDependencies[name],
        }));
    }

    item.depChain = findDepChain(item.libraryName, depTree, rootDeps);

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
          chainVia: item.depChain.slice(1, -1),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runAnalysisPipeline
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string}  opts.reportPath           - Path to vulnerability report (required)
 * @param {string}  [opts.providerOverride]   - Force a specific provider parser
 * @param {string}  [opts.ecosystemOverride]  - Force a specific ecosystem
 * @param {boolean} [opts.verifyVersions]     - Query registry to confirm versions exist
 * @param {string}  [opts.lockFilePath]       - npm: package-lock.json
 * @param {string}  [opts.packageJsonPath]    - npm: package.json (used by parent explorer)
 * @param {string}  [opts.pomXmlPath]         - Maven: pom.xml
 * @param {string}  [opts.requirementsTxtPath]- Python: requirements.txt / lock file
 * @param {string}  [opts.goModPath]          - Go: go.mod
 * @param {string}  [opts.packagesPropsPath]  - .NET: Directory.Packages.props / .csproj
 * @param {string}  [opts.cargoTomlPath]      - Rust: Cargo.toml
 * @param {number}  [opts.maxDepth]           - Max depth for npm parent-chain exploration
 * @param {number}  [opts.maxSimulations]     - Max npm install simulations
 * @param {boolean} [opts.classifyExposure]   - D1A: run exposure classifier (default false)
 * @param {object}  [opts.packageJson]        - Parsed package.json for exposure scripts scan
 *
 * @returns {Promise<{
 *   entries:             LibraryEntry[],
 *   ecosystem:           string,
 *   provider:            string,
 *   phasedPlan:          PhasedItem[],
 *   depTree:             Map|null,
 *   registryAdjustments: Array<{name, requested, adjusted}>,
 *   exposureResults:     Array<{item, exposureResult}>|null
 * }>}
 */
async function runAnalysisPipeline(opts = {}) {
  const {
    reportPath,
    providerOverride    = null,
    ecosystemOverride   = null,
    verifyVersions      = false,
    lockFilePath        = null,
    packageJsonPath     = null,
    pomXmlPath          = null,
    requirementsTxtPath = null,
    goModPath           = null,
    packagesPropsPath   = null,
    cargoTomlPath       = null,
    maxDepth            = undefined,
    maxSimulations      = undefined,
    classifyExposure    = false,
    packageJson         = null,
  } = opts;

  if (!reportPath) throw new Error('runAnalysisPipeline: reportPath is required');

  // 1. Parse report
  const provider = providerOverride || detectProvider(reportPath);
  const entries  = getParser(provider).parseReport(reportPath);

  // 2. Detect ecosystem
  const ecosystem = detectEcosystem(entries, ecosystemOverride);

  // 3. Load dep tree (non-fatal on error)
  const { depTree, rootDeps } = loadDepTree(ecosystem, {
    reportPath, lockFilePath, pomXmlPath, requirementsTxtPath,
    goModPath, packagesPropsPath, cargoTomlPath,
  });

  // 4. SemVer resolution
  let plan = buildResolutionPlan(entries);

  // 5. Optional registry verification
  const registryAdjustments = [];
  if (verifyVersions && REGISTRY_VERIFIERS[ecosystem]) {
    const verifyFn = REGISTRY_VERIFIERS[ecosystem]();
    plan = await verifyFn(plan);
    for (const item of plan) {
      if (item.registryAdjusted) {
        registryAdjustments.push({
          name:     item.libraryName,
          requested: item.registryRequested,
          adjusted:  item.recommendedVersion,
        });
      }
    }
  }

  // 6. Phase classification
  let phasedPlan = applyPhases(plan, depTree, rootDeps);

  // 6.5. Escalate to Phase C when registry confirmed version doesn't exist
  if (verifyVersions) {
    for (const item of phasedPlan) {
      if (item.registryExists === false && item.phase !== 'C') {
        item.phase         = 'C';
        item.justification = `Recommended version ${item.recommendedVersion} is not published on the registry. No verified fix available.`;
      }
    }
  }

  // 7. npm-specific: rootParents + depChain enrichment for Phase C MAJOR_BUMP
  if (ecosystem === 'npm') {
    enrichNpmChains(phasedPlan, depTree, rootDeps);

    // 7b. Parent upgrade exploration (npm + verifyVersions only)
    if (verifyVersions && lockFilePath) {
      const { exploreParentUpgrades } = require('./src/ecosystems/npm/parent-upgrade-explorer');
      await exploreParentUpgrades(phasedPlan, 'npm', packageJsonPath, lockFilePath,
        { maxDepth, maxSimulations });
    }
  }

  // 8. Confidence enrichment
  phasedPlan = enrichWithConfidence(phasedPlan, depTree);

  // 9. Remediation path enrichment
  phasedPlan = enrichWithPaths(phasedPlan, entries);

  // 10. D1A: Exposure classification (opt-in)
  let exposureResults = null;
  if (classifyExposure) {
    exposureResults = classifyPlanExposure(phasedPlan, depTree, { packageJson });
  }

  return { entries, ecosystem, provider, phasedPlan, depTree, registryAdjustments, exposureResults };
}

module.exports = { runAnalysisPipeline };
