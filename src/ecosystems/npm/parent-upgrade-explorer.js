'use strict';

const semver = require('semver');
const { getPublishedVersions } = require('./registry');

const REGISTRY_URL = 'https://registry.npmjs.org';
const TIMEOUT_MS   = 8000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the declared dependencies for a specific published version of a package.
 * Returns { dependencies, peerDependencies } or null on failure.
 */
async function getVersionDeps(packageName, version) {
  const data = await fetchJson(
    `${REGISTRY_URL}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
  );
  if (!data) return null;
  return {
    dependencies:     data.dependencies     || {},
    peerDependencies: data.peerDependencies || {},
  };
}

/**
 * For a MAJOR_BUMP Phase C item, walk each root parent's published versions
 * (within the semver range the project already allows) and find the latest
 * parent version whose declared dependency on the vulnerable child covers the
 * fix version.
 *
 * The check: semver.intersects(childRange, '>=' + fixVersion)
 *   true  → the parent's declared range can resolve to a safe child version
 *   false → the parent still pins the vulnerable major
 *
 * Returns an array (one entry per parent that has a viable upgrade):
 *   [{
 *     parent:               string,   // e.g. 'y'
 *     parentAllowedRange:   string,   // e.g. '^1.5.0'   (from project package.json)
 *     parentUpgradeVersion: string,   // e.g. '1.6.0'    (latest within range that fixes child)
 *     childDeclaredRange:   string,   // e.g. '^2.1.0'   (what that parent version declares)
 *     childFixVersion:      string,   // e.g. '2.2.0'    (minimum safe version)
 *     isDev:                boolean,
 *   }]
 *
 * Empty array = no parent upgrade path found within current semver constraints.
 */
async function findParentUpgradePaths(item) {
  if (!item.rootParents || item.rootParents.length === 0) return [];
  if (!item.recommendedVersion) return [];

  const fixVersion = item.recommendedVersion;
  const childName  = item.libraryName;
  const paths      = [];

  for (const parent of item.rootParents) {
    const { name: parentName, range: allowedRange } = parent;

    const allVersions = await getPublishedVersions(parentName);
    if (!allVersions) continue;

    // Only consider versions the project already allows (within declared range).
    // Sort descending so we find the latest compatible upgrade first.
    const candidates = allVersions
      .filter(v => semver.valid(v) && semver.satisfies(v, allowedRange))
      .sort((a, b) => semver.rcompare(a, b));

    if (candidates.length === 0) continue;

    for (const candidateVersion of candidates) {
      const deps = await getVersionDeps(parentName, candidateVersion);
      if (!deps) continue;

      const childRange =
        deps.dependencies[childName] || deps.peerDependencies[childName];
      if (!childRange) continue;

      // Does this parent's declared child range intersect with >= fixVersion?
      let covers = false;
      try {
        covers = semver.intersects(childRange, '>=' + fixVersion);
      } catch {
        // Unparseable range (dist-tag, URL, etc.) — skip safely
      }

      if (covers) {
        paths.push({
          parent:               parentName,
          parentAllowedRange:   allowedRange,
          parentUpgradeVersion: candidateVersion,
          childDeclaredRange:   childRange,
          childFixVersion:      fixVersion,
          isDev:                parent.isDev || false,
        });
        break; // earliest (latest-version) match found for this parent; stop scanning older versions
      }
    }
  }

  return paths;
}

/**
 * Run parent upgrade exploration for all MAJOR_BUMP Phase C items in a phased plan.
 * Mutates items in place: sets parentUpgradePaths and promotes phase C → B on success.
 * Logs progress dots to stdout.
 *
 * @param {object[]} phasedPlan  — mutated in place
 * @param {string}   ecosystem
 */
async function exploreParentUpgrades(phasedPlan, ecosystem) {
  if (ecosystem !== 'npm') return;

  const candidates = phasedPlan.filter(
    i => i.phase === 'C' && i.upgradeType === 'MAJOR_BUMP' &&
         i.rootParents && i.rootParents.length > 0
  );

  if (candidates.length === 0) return;

  process.stdout.write('  Checking parent upgrade paths');

  for (const item of candidates) {
    const paths = await findParentUpgradePaths(item);
    process.stdout.write('.');

    item._parentExplorationRan = true; // so manual-review.md can show "no path found"

    if (paths.length === 0) continue;

    item.parentUpgradePaths = paths;
    item.phase              = 'B';

    const parentSummary = paths
      .map(p => `\`${p.parent}\` ${p.parentAllowedRange} → ${p.parentUpgradeVersion}`)
      .join(', ');
    const childSummary = paths
      .map(p => `${p.childDeclaredRange}`)
      .join(', ');

    item.justification =
      `MAJOR_BUMP resolved via parent upgrade: ${parentSummary}. ` +
      `Upgraded parent declares \`${item.libraryName}@${childSummary}\`. ` +
      `Verify: run \`npm install --package-lock-only\` and confirm ${item.libraryName} resolves to >=${item.recommendedVersion}.`;
  }

  process.stdout.write(' done\n');
}

module.exports = { findParentUpgradePaths, exploreParentUpgrades };
