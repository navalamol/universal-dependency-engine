'use strict';

const semver = require('semver');

/**
 * Cross-reference a simulation's resolvedVersions against the known findings set.
 *
 * "introduced" = a finding where the current version was already >= fixVersion (safe),
 *                but the simulated version regressed below fixVersion (newly vulnerable).
 * "fixed"      = a finding where the current version was < fixVersion (vulnerable),
 *                and the simulated version is >= fixVersion (now safe).
 *
 * @param {Map<string, string>} resolvedVersions  — from SimulationResult.resolvedVersions
 * @param {object[]}            findings          — LibraryEntry[] from parseReport()
 * @returns {{ introduced: Array<{name,version,cves}>, fixed: Array<{name,version,cves}> }}
 */
function computeSecurityDelta(resolvedVersions, findings) {
  if (!resolvedVersions || resolvedVersions.size === 0 || !findings || !findings.length) {
    return { introduced: [], fixed: [] };
  }

  const introduced = [];
  const fixed      = [];

  for (const finding of findings) {
    const { libraryName, currentVersion, cves } = finding;
    const simulatedVersion = resolvedVersions.get(libraryName);
    if (!simulatedVersion || !semver.valid(simulatedVersion)) continue;

    const minFixVersion = _minFix(cves);
    if (!minFixVersion) continue;

    const currentlyVulnerable  = semver.valid(currentVersion) && semver.lt(currentVersion, minFixVersion);
    const simulatedVulnerable  = semver.lt(simulatedVersion, minFixVersion);
    const cveIds = cves.map(c => c.id);

    if (currentlyVulnerable && !simulatedVulnerable) {
      fixed.push({ name: libraryName, version: simulatedVersion, cves: cveIds });
    } else if (!currentlyVulnerable && simulatedVulnerable) {
      // Regression: simulation downgrades a package that was already safe
      introduced.push({ name: libraryName, version: simulatedVersion, cves: cveIds });
    }
  }

  return { introduced, fixed };
}

function _minFix(cves) {
  const fixes = (cves || [])
    .flatMap(c => c.fixVersions || [])
    .map(v => semver.valid(semver.coerce(v)))
    .filter(Boolean);
  if (!fixes.length) return null;
  return fixes.sort(semver.compare)[0];
}

module.exports = { computeSecurityDelta };
