'use strict';

const semver = require('semver');

/**
 * Resolve the currently-installed version of a package.
 * Checks direct deps in package.json first (strips range prefix), then falls back
 * to lock file resolved versions (lowest = most likely the vulnerable instance).
 */
function getCurrentVersion(packageName, pkg, lockEntries) {
  const allDeps = Object.assign(
    {},
    pkg.dependencies    || {},
    pkg.devDependencies || {},
    pkg.peerDependencies || {}
  );

  if (allDeps[packageName] !== undefined) {
    return semver.valid(semver.coerce(allDeps[packageName])) || null;
  }

  if (lockEntries) {
    const entries = lockEntries.get(packageName) || [];
    const versions = entries
      .map(e => e.resolvedVersion)
      .filter(v => semver.valid(v))
      .sort(semver.compare);
    return versions[0] || null;
  }

  return null;
}

/**
 * Convert Renovate PR upgrade intents into ResolutionItem[] compatible with
 * the phase engine (phases.applyPhases).
 *
 * Items are shaped identically to buildResolutionPlan output, with cves: []
 * (no CVE data for Renovate) plus prNumber/prTitle for report attribution.
 *
 * @param {object[]} prUpgrades   [{prNumber, prTitle, packageName, proposedVersion}]
 * @param {object}   pkg          parsed package.json from the cloned repo
 * @param {Map}      [lockEntries] from lock-parser.parseLockFile(); optional but recommended
 * @returns {{ items: object[], notFound: object[] }}
 */
function buildResolutionItems(prUpgrades, pkg, lockEntries) {
  const items    = [];
  const notFound = [];

  for (const { prNumber, prTitle, packageName, proposedVersion, oldPackageName, isMonorepoGroup, isPackageGroup } of prUpgrades) {
    // Monorepo group PRs have no target version — cannot phase-classify
    if (isMonorepoGroup) {
      notFound.push({ prNumber, prTitle, packageName, proposedVersion: null, isMonorepoGroup: true });
      continue;
    }

    // Replace PRs: the old package is currently installed; look it up for currentVersion
    const lookupName = oldPackageName || packageName;
    const currentVersion = getCurrentVersion(lookupName, pkg, lockEntries);

    if (!currentVersion) {
      notFound.push({ prNumber, prTitle, packageName, proposedVersion, ...(isPackageGroup ? { isPackageGroup: true } : {}) });
      continue;
    }

    // Replace PRs always go to Phase C — they swap one package for a different one
    const upgradeType = oldPackageName
      ? 'MAJOR_BUMP'
      : (semver.valid(currentVersion) && semver.valid(proposedVersion) &&
          semver.major(proposedVersion) > semver.major(currentVersion)
          ? 'MAJOR_BUMP'
          : 'SAFE');

    items.push({
      libraryName:        packageName,
      libraryType:        'NODE_PACKAGED_MODULE',
      currentVersion,
      recommendedVersion: proposedVersion,
      upgradeType,
      cves:               [],
      cveCount:           0,
      highestSeverity:    'UNKNOWN',
      highestCvssScore:   0,
      filename:           'package.json',
      dependencyFile:     'package.json',
      prNumber,
      prTitle,
      ...(oldPackageName ? { replacesPkg: oldPackageName } : {}),
    });
  }

  return { items, notFound };
}

module.exports = { getCurrentVersion, buildResolutionItems };
