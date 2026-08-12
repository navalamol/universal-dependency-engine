'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { parseLockFile } = require('./lock-parser');

const DEFAULT_TIMEOUT_MS      = 30_000;
const DEFAULT_MAX_SIMULATIONS = 20;

// Per-run caches keyed by hash(modified package.json content).
const _simCache = new Map();
let   _simCount = 0;

/**
 * Simulate `npm install --package-lock-only` for each candidate version change.
 *
 * @param {string}       basePackageJsonPath
 * @param {string|null}  baseLockPath    — copied into temp dir if present
 * @param {Array<{name:string, from:string, to:string}>} candidates
 * @param {{ timeoutMs?: number, maxSimulations?: number }} [options]
 * @returns {SimulationResult[]}
 *
 * SimulationResult {
 *   candidate:        { name, from, to },
 *   success:          boolean,
 *   resolvedVersions: Map<packageName, resolvedVersion>,
 *   peerConflicts:    string[],
 *   timedOut:         boolean,
 *   limitExceeded:    boolean,
 *   error:            string | null,
 * }
 */
function simulate(basePackageJsonPath, baseLockPath, candidates, options = {}) {
  const timeoutMs      = options.timeoutMs      ?? DEFAULT_TIMEOUT_MS;
  const maxSimulations = options.maxSimulations ?? DEFAULT_MAX_SIMULATIONS;

  const basePkg = JSON.parse(fs.readFileSync(basePackageJsonPath, 'utf8'));

  return candidates.map(candidate => {
    if (_simCount >= maxSimulations) {
      return {
        candidate, success: false, resolvedVersions: new Map(),
        peerConflicts: [], timedOut: false, limitExceeded: true,
        error: 'SIMULATION_LIMIT_EXCEEDED',
      };
    }

    const modifiedPkg = applyCandidate(basePkg, candidate);
    const pkgContent  = JSON.stringify(modifiedPkg, null, 2);
    const cacheKey    = crypto.createHash('sha256').update(pkgContent).digest('hex');

    if (_simCache.has(cacheKey)) {
      return { ..._simCache.get(cacheKey), candidate };
    }

    _simCount++;
    const result = runOne(pkgContent, baseLockPath, candidate, timeoutMs);
    _simCache.set(cacheKey, result);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyCandidate(basePkg, candidate) {
  const pkg = JSON.parse(JSON.stringify(basePkg));
  const { name, to } = candidate;

  let found = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[field] && name in pkg[field]) {
      pkg[field][name] = to;
      found = true;
    }
  }
  // If the package is only transitive (not a direct dep), add it to overrides
  // so npm resolves it to the target version in the simulated lockfile.
  if (!found) {
    pkg.overrides = pkg.overrides || {};
    pkg.overrides[name] = to;
  }
  return pkg;
}

function runOne(pkgContent, baseLockPath, candidate, timeoutMs) {
  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mend-sim-'));

    fs.writeFileSync(path.join(tempDir, 'package.json'), pkgContent, 'utf8');

    if (baseLockPath && fs.existsSync(baseLockPath)) {
      fs.copyFileSync(baseLockPath, path.join(tempDir, 'package-lock.json'));
    }

    const result = spawnSync('npm', [
      'install',
      '--package-lock-only',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    ], {
      cwd:     tempDir,
      timeout: timeoutMs,
      encoding: 'utf8',
      shell:   true,  // required for Windows npm.cmd resolution
    });

    const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT') ||
                     result.signal === 'SIGTERM';
    if (timedOut) {
      return { candidate, success: false, resolvedVersions: new Map(), peerConflicts: [], timedOut: true, limitExceeded: false, error: null };
    }

    if (result.status !== 0) {
      const peerConflicts = extractPeerConflicts(result.stderr || '');
      return {
        candidate, success: false, resolvedVersions: new Map(),
        peerConflicts, timedOut: false, limitExceeded: false,
        error: (result.stderr || result.stdout || '').slice(0, 400),
      };
    }

    const lockPath = path.join(tempDir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      return { candidate, success: false, resolvedVersions: new Map(), peerConflicts: [], timedOut: false, limitExceeded: false, error: 'No lockfile produced' };
    }

    const depTree         = parseLockFile(lockPath);
    const resolvedVersions = new Map();
    for (const [name, entries] of depTree) {
      if (entries.length > 0) resolvedVersions.set(name, entries[0].resolvedVersion);
    }

    return {
      candidate, success: true, resolvedVersions,
      peerConflicts: extractPeerConflicts(result.stderr || ''),
      timedOut: false, limitExceeded: false, error: null,
    };
  } catch (err) {
    return {
      candidate, success: false, resolvedVersions: new Map(),
      peerConflicts: [], timedOut: false, limitExceeded: false,
      error: err.message,
    };
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function extractPeerConflicts(stderr) {
  return stderr
    .split('\n')
    .filter(line => /ERESOLVE|peer dep|Could not resolve/i.test(line))
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

module.exports = { simulate };
