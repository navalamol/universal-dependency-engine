'use strict';

// D1A — Environmental exposure classifier.
// Classifies a vulnerable package's exposure context using static evidence:
//   lockfile dep flags · root dep classification · dep chain · package name patterns
//   · optional package.json scripts scanning
//
// RULE: devDependency flag alone never implies "not critical".
//       Build/CI deps execute with elevated credentials in many pipelines.
//       Vulnerability severity is PRESERVED; exposure is reported separately.

const { EXPOSURE } = require('./evidence-model');

// ─── Pattern tables ───────────────────────────────────────────────────────────

const TEST_FRAMEWORK_PATTERNS = [
  /^jest($|[-/])/, /^@jest\//, /^vitest($|[-/])/, /^@vitest\//,
  /^mocha($|[-/])/, /^jasmine($|[-/])/, /^karma($|[-/])/,
  /^chai($|[-/])/, /^sinon($|[-/])/, /^nock($|[-/])/,
  /^nyc($|[-/])/, /^istanbul/, /^c8($|[-/])/,
  /^tape($|[-/])/, /^ava($|[-/])/,
  /^puppeteer($|[-/])/, /^playwright($|[-/])/, /^cypress($|[-/])/, /^selenium/,
  /^supertest($|[-/])/, /^@testing-library\//,
];

const BUILD_TOOL_PATTERNS = [
  /^webpack($|[-/])/, /^rollup($|[-/])/, /^vite($|[-/])/, /^esbuild($|[-/])/,
  /^parcel($|[-/])/, /^babel($|[-/])/, /^@babel\//,
  /^typescript($|[-/])/, /^ts-node($|[-/])/,
  /^terser($|[-/])/, /^uglify-js($|[-/])/,
  /^postcss($|[-/])/, /^sass($|[-/])/, /^less($|[-/])/, /^stylus($|[-/])/,
  /^@swc\//, /^swc($|[-/])/,
  /^nx($|[-/])/, /^turbo($|[-/])/, /^lerna($|[-/])/, /^@lerna\//,
  /^eslint($|[-/])/, /^prettier($|[-/])/,
  /^husky($|[-/])/, /^lint-staged($|[-/])/,
];

const CI_TOOL_PATTERNS = [
  /^cross-env($|[-/])/, /^env-cmd($|[-/])/,
  /^rimraf($|[-/])/, /^del-cli($|[-/])/,
  /^concurrently($|[-/])/, /^wait-on($|[-/])/,
  /^nodemon($|[-/])/, /^pm2($|[-/])/,
];

// ─── classifyExposure ─────────────────────────────────────────────────────────

/**
 * Classify the environmental exposure of a vulnerable package.
 *
 * @param {object} item      - PhasedItem (output of phases.js)
 * @param {Map}    depTree   - DepTree (Map<name, Entry[]>), may be null
 * @param {object} [opts]
 * @param {object} [opts.packageJson]  - Parsed package.json (enables scripts scanning)
 * @returns {{ classification: string, confidence: number, evidenceSources: string[] }}
 */
function classifyExposure(item, depTree, opts = {}) {
  const { packageJson } = opts;
  const name = item.libraryName;
  const sources = [];

  // ── No dep tree: UNKNOWN ──────────────────────────────────────────────────
  if (!depTree || !(depTree instanceof Map)) {
    return {
      classification:  EXPOSURE.UNKNOWN_EXPOSURE,
      confidence:      0,
      evidenceSources: ['no-dep-tree'],
    };
  }

  const entries = depTree.get(name) || [];
  if (entries.length === 0) {
    return {
      classification:  EXPOSURE.UNKNOWN_EXPOSURE,
      confidence:      0.1,
      evidenceSources: ['package-not-in-lock-tree'],
    };
  }

  // ── Lockfile dev flags ─────────────────────────────────────────────────────
  // An entry with dev=false (or dev=null/undefined) is a production-path entry.
  const allDev  = entries.every(e => e.dev === true);
  const anyProd = entries.some(e => e.dev === false || e.dev == null);

  // ── Root parent flags ─────────────────────────────────────────────────────
  const rootParents         = item.rootParents || [];
  const hasNonDevRootParent = rootParents.some(p => p.isDev === false);
  const allRootParentsDev   = rootParents.length > 0 && rootParents.every(p => p.isDev === true);

  // ── Production path ────────────────────────────────────────────────────────
  if (anyProd) {
    sources.push('lock-file: non-dev entry');
    if (hasNonDevRootParent) sources.push('root-parent: isDev=false');

    // Direct dep (chain length 0 or 1) → likely loaded at runtime directly
    const chainLen = Array.isArray(item.depChain) ? item.depChain.length : 0;
    if (chainLen <= 1) {
      sources.push('dep-chain: direct dependency');
      return { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.85, evidenceSources: sources };
    }
    // Transitive non-dev → bundled in production artifact
    sources.push(`dep-chain: transitive (depth ${chainLen})`);
    return { classification: EXPOSURE.PRODUCTION_BUNDLED, confidence: 0.75, evidenceSources: sources };
  }

  // ── All-dev: classify intent ───────────────────────────────────────────────
  // RULE: dev flag alone does NOT mean "not critical" — we still classify
  //       the execution context precisely so callers can decide priority.
  sources.push('lock-file: all entries dev=true');
  if (allRootParentsDev) sources.push('root-parents: all isDev=true');

  // Optional: package.json scripts scanning
  const scriptMatch = packageJson ? _findInScripts(name, packageJson) : null;
  if (scriptMatch) {
    sources.push(`lifecycle-scripts: used in "${scriptMatch.scriptName}"`);
  }

  // Test framework name patterns
  if (TEST_FRAMEWORK_PATTERNS.some(p => p.test(name))) {
    sources.push('package-name: matches test-framework pattern');
    return { classification: EXPOSURE.TEST_ONLY, confidence: 0.8, evidenceSources: sources };
  }

  // Build tool name patterns
  if (BUILD_TOOL_PATTERNS.some(p => p.test(name))) {
    sources.push('package-name: matches build-tool pattern');
    return { classification: EXPOSURE.BUILD_TIME_EXECUTED, confidence: 0.75, evidenceSources: sources };
  }

  // CI / script runner name patterns
  if (CI_TOOL_PATTERNS.some(p => p.test(name))) {
    sources.push('package-name: matches CI-tool pattern');
    return { classification: EXPOSURE.CI_EXECUTED, confidence: 0.70, evidenceSources: sources };
  }

  // Disambiguate via script name context (if packageJson was provided)
  if (scriptMatch) {
    const sn = scriptMatch.scriptName.toLowerCase();
    if (/test|spec|e2e|coverage/.test(sn)) {
      return { classification: EXPOSURE.TEST_ONLY, confidence: 0.70, evidenceSources: sources };
    }
    if (/build|compile|bundle|prepare|prebuild/.test(sn)) {
      return { classification: EXPOSURE.BUILD_TIME_EXECUTED, confidence: 0.70, evidenceSources: sources };
    }
    if (/ci|lint|check|format/.test(sn)) {
      return { classification: EXPOSURE.CI_EXECUTED, confidence: 0.65, evidenceSources: sources };
    }
  }

  // Generic dev dependency with no clearer signal
  return { classification: EXPOSURE.LOCAL_TOOLING_ONLY, confidence: 0.60, evidenceSources: sources };
}

// ─── classifyPlanExposure ─────────────────────────────────────────────────────

/**
 * Classify exposure for every item in a phasedPlan.
 *
 * @param {object[]} phasedPlan
 * @param {Map}      depTree
 * @param {object}   [opts]   - same opts as classifyExposure
 * @returns {Array<{ item: object, exposureResult: object }>}
 */
function classifyPlanExposure(phasedPlan, depTree, opts = {}) {
  return (phasedPlan || []).map(item => ({
    item,
    exposureResult: classifyExposure(item, depTree, opts),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the first script entry that references pkgName, or null.
 * @param {string} pkgName
 * @param {object} packageJson
 * @returns {{ scriptName: string, cmd: string } | null}
 */
function _findInScripts(pkgName, packageJson) {
  const scripts = packageJson && packageJson.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  for (const [scriptName, cmd] of Object.entries(scripts)) {
    if (typeof cmd === 'string' && cmd.includes(pkgName)) {
      return { scriptName, cmd };
    }
  }
  return null;
}

module.exports = { classifyExposure, classifyPlanExposure };
