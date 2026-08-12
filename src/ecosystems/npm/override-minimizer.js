'use strict';

const fs     = require('fs');
const semver = require('semver');
const { simulatePackage } = require('./simulator');

/**
 * Iteratively remove npm overrides that are provably unnecessary.
 *
 * For each flat-string override, we simulate `npm install --package-lock-only`
 * on a copy of package.json with that override absent.  If the resolved version
 * in the simulated lockfile is still >= the pinned version, the override is not
 * needed and can be removed.
 *
 * We iterate in rounds: each round processes the remaining overrides using the
 * post-removal package.json state from the previous round.  Rounds continue
 * until a round produces zero new removals (stable).
 *
 * Nested overrides (object values) are skipped — they encode multi-major
 * conflicts that require human judgment.
 *
 * @param {string} packageJsonPath
 * @param {string} lockFilePath
 * @param {{
 *   timeoutMs?:      number,
 *   maxSimulations?: number,
 *   dryRun?:         boolean,  // when true, do not write to packageJsonPath
 * }} [options]
 *
 * @returns {{
 *   removed:  string[],   // override keys removed
 *   kept:     string[],   // override keys that could not be removed (still needed)
 *   skipped:  string[],   // nested overrides — not evaluated
 *   limitHit: boolean,    // true if simulation limit was reached before all were tested
 * }}
 */
function minimizeOverrides(packageJsonPath, lockFilePath, options = {}) {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found: ${packageJsonPath}`);
  }

  const rawPkg = fs.readFileSync(packageJsonPath, 'utf8');
  let   pkg    = JSON.parse(rawPkg);

  const allOverrides  = pkg.overrides || {};
  const skipped       = Object.entries(allOverrides)
    .filter(([, v]) => typeof v !== 'string')
    .map(([k]) => k);

  // Working state — starts as all flat overrides; candidates shrink each round
  const flat = Object.entries(allOverrides)
    .filter(([, v]) => typeof v === 'string');

  if (flat.length === 0) {
    return { removed: [], kept: [], skipped, limitHit: false };
  }

  const removed  = [];
  const kept     = [];
  let   limitHit = false;

  // Keep a working copy of pkg that reflects removals from prior rounds
  let workingPkg = deepClone(pkg);

  // Only test overrides that haven't been resolved yet
  let candidates = flat.map(([k, v]) => ({ name: k, pinnedVersion: v }));

  while (candidates.length > 0) {
    const removedThisRound = [];

    for (const { name, pinnedVersion } of candidates) {
      const candidate = withoutOverride(workingPkg, name);
      const simResult = simulatePackage(candidate, lockFilePath, {
        timeoutMs:      options.timeoutMs,
        maxSimulations: options.maxSimulations,
      });

      if (simResult.limitExceeded) {
        limitHit = true;
        // Put remaining candidates in `kept` (unknown outcome)
        const remaining = candidates.filter(c => !removedThisRound.find(r => r === c.name));
        for (const c of remaining) kept.push(c.name);
        candidates = [];
        break;
      }

      if (!simResult.success) {
        kept.push(name);
        continue;
      }

      const resolved = simResult.resolvedVersions.get(name);
      if (resolved && semver.valid(resolved) && semver.valid(pinnedVersion) &&
          semver.gte(resolved, pinnedVersion)) {
        removed.push(name);
        removedThisRound.push(name);
        // Apply removal to working state so the next candidates see the updated pkg
        delete workingPkg.overrides[name];
        if (Object.keys(workingPkg.overrides).length === 0) delete workingPkg.overrides;
      } else {
        kept.push(name);
      }
    }

    if (removedThisRound.length === 0) break;
    candidates = candidates.filter(c => !removed.includes(c.name) && !kept.includes(c.name));
  }

  if (!options.dryRun && removed.length > 0) {
    // Re-read to preserve formatting/comments, then apply removals
    const freshPkg = JSON.parse(rawPkg);
    for (const name of removed) {
      if (freshPkg.overrides) delete freshPkg.overrides[name];
    }
    if (freshPkg.overrides && Object.keys(freshPkg.overrides).length === 0) {
      delete freshPkg.overrides;
    }
    const indent = detectIndent(rawPkg);
    fs.writeFileSync(packageJsonPath, JSON.stringify(freshPkg, null, indent) + '\n', 'utf8');
  }

  return { removed, kept, skipped, limitHit };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withoutOverride(pkg, name) {
  const copy = deepClone(pkg);
  if (copy.overrides) {
    delete copy.overrides[name];
    if (Object.keys(copy.overrides).length === 0) delete copy.overrides;
  }
  return copy;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function detectIndent(raw) {
  const m = raw.match(/^[{[]\r?\n([ \t]+)/);
  if (!m) return 2;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

module.exports = { minimizeOverrides };
