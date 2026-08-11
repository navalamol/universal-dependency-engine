'use strict';

const semver = require('semver');

/**
 * For a single library entry, determine the minimum fix version and upgrade type.
 *
 * Strategy:
 *   1. For each CVE, find the minimum same-major fix version (> current).
 *   2. The required fix = max of all per-CVE minimums (covers every CVE).
 *   3. If any CVE has no same-major fix → fall back to cross-major (MAJOR_BUMP).
 *   4. Find the minimum version across all CVEs that covers all of them.
 *
 * Returns: { recommendedVersion: string|null, upgradeType: 'SAFE'|'MAJOR_BUMP'|'NO_FIX' }
 */
function resolveFixVersion(entry) {
  const { currentVersion, cves } = entry;

  if (!semver.valid(currentVersion)) {
    return { recommendedVersion: null, upgradeType: 'NO_FIX' };
  }

  if (!cves || cves.length === 0) {
    return { recommendedVersion: null, upgradeType: 'NO_FIX' };
  }

  const currentMajor = semver.major(currentVersion);
  const perCveMin = [];
  let anyNeedsMajorBump = false;

  for (const cve of cves) {
    const validFixes = (cve.fixVersions || []).filter(v => semver.valid(v));

    if (validFixes.length === 0) {
      anyNeedsMajorBump = true;
      perCveMin.push({ cveId: cve.id, version: null });
      continue;
    }

    const sameMajor = validFixes
      .filter(v => semver.major(v) === currentMajor && semver.gt(v, currentVersion))
      .sort(semver.compare);

    if (sameMajor.length > 0) {
      perCveMin.push({ cveId: cve.id, version: sameMajor[0] }); // minimum same-major fix
    } else {
      anyNeedsMajorBump = true;
      perCveMin.push({ cveId: cve.id, version: null });
    }
  }

  // --- Path A: all CVEs fixable within same major ---
  if (!anyNeedsMajorBump && perCveMin.every(e => e.version)) {
    const versions = perCveMin.map(e => e.version);
    const recommended = versions.sort(semver.compare).pop(); // max of minimums
    return { recommendedVersion: recommended, upgradeType: 'SAFE' };
  }

  // --- Path B: at least one CVE needs a cross-major (or has no same-major fix) ---
  const allFixes = cves
    .flatMap(c => (c.fixVersions || []).filter(v => semver.valid(v) && semver.gt(v, currentVersion)));

  if (allFixes.length === 0) {
    return { recommendedVersion: null, upgradeType: 'NO_FIX' };
  }

  const sortedUnique = [...new Set(allFixes)].sort(semver.compare);

  // Find the minimum candidate that covers ALL CVEs
  for (const candidate of sortedUnique) {
    const coversAll = cves.every(cve => {
      const applicable = (cve.fixVersions || [])
        .filter(v => semver.valid(v) && semver.gt(v, currentVersion))
        .sort(semver.compare);
      // No fix versions listed for this CVE → cannot confirm coverage
      if (!applicable.length) return false;
      // candidate must be >= the minimum applicable fix version
      return semver.gte(candidate, applicable[0]);
    });

    if (coversAll) {
      return { recommendedVersion: candidate, upgradeType: 'MAJOR_BUMP' };
    }
  }

  // Fallback: highest available fix
  return {
    recommendedVersion: sortedUnique[sortedUnique.length - 1],
    upgradeType: 'MAJOR_BUMP',
  };
}

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

function highestSeverity(cves) {
  let best = 'UNKNOWN';
  for (const cve of cves) {
    const sev = (cve.severity || '').toUpperCase();
    if ((SEVERITY_RANK[sev] || 0) > (SEVERITY_RANK[best] || 0)) best = sev;
  }
  return best;
}

/**
 * Process all library entries from the parsed report and produce a resolution plan.
 *
 * Returns: ResolutionItem[]
 *   { libraryName, currentVersion, recommendedVersion, upgradeType,
 *     cveCount, highestSeverity, highestCvssScore, cves, dependencyFile }
 */
function buildResolutionPlan(entries) {
  return entries.map(entry => {
    const { recommendedVersion, upgradeType } = resolveFixVersion(entry);

    return {
      libraryName:       entry.libraryName,
      groupId:           entry.groupId || null,
      libraryType:       entry.libraryType || 'NODE_PACKAGED_MODULE',
      currentVersion:    entry.currentVersion,
      filename:          entry.filename,
      dependencyFile:    entry.dependencyFile,
      cves:              entry.cves,
      cveCount:          entry.cves.length,
      highestSeverity:   highestSeverity(entry.cves),
      highestCvssScore:  Math.max(0, ...entry.cves.map(c => c.score || 0)),
      recommendedVersion,
      upgradeType,
    };
  });
}

module.exports = { resolveFixVersion, buildResolutionPlan };
