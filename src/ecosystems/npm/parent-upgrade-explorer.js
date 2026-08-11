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
 * Handles both direct and indirect chains:
 *   Direct  (chainVia absent): rootDep → vulnerableChild
 *   Indirect (chainVia present): rootDep → intermediate → vulnerableChild
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
 *     chainVia:             string[], // intermediate packages (empty for direct parents)
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
    const { name: parentName, range: allowedRange, chainVia } = parent;

    const allVersions = await getPublishedVersions(parentName);
    if (!allVersions) continue;

    // Only consider versions the project already allows (within declared range).
    // Sort descending so we find the latest compatible upgrade first.
    const candidates = allVersions
      .filter(v => semver.valid(v) && semver.satisfies(v, allowedRange))
      .sort((a, b) => semver.rcompare(a, b));

    if (candidates.length === 0) continue;

    if (chainVia && chainVia.length > 0) {
      // Indirect chain: rootDep → intermediate(s) → vulnerableChild
      // For each candidate root version, follow the intermediate chain to find
      // the child range it would ultimately declare.
      for (const candidateVersion of candidates) {
        const childRange = await resolveChainChildRange(
          parentName, candidateVersion, chainVia, childName
        );
        if (!childRange) continue;

        let covers = false;
        try { covers = semver.intersects(childRange, '>=' + fixVersion); } catch {}

        if (covers) {
          paths.push({
            parent:               parentName,
            parentAllowedRange:   allowedRange,
            parentUpgradeVersion: candidateVersion,
            childDeclaredRange:   childRange,
            childFixVersion:      fixVersion,
            chainVia:             chainVia,
            isDev:                parent.isDev || false,
          });
          break;
        }
      }
    } else {
      // Direct parent: rootDep directly declares vulnerableChild
      for (const candidateVersion of candidates) {
        const deps = await getVersionDeps(parentName, candidateVersion);
        if (!deps) continue;

        const childRange =
          deps.dependencies[childName] || deps.peerDependencies[childName];
        if (!childRange) continue;

        let covers = false;
        try { covers = semver.intersects(childRange, '>=' + fixVersion); } catch {}

        if (covers) {
          paths.push({
            parent:               parentName,
            parentAllowedRange:   allowedRange,
            parentUpgradeVersion: candidateVersion,
            childDeclaredRange:   childRange,
            childFixVersion:      fixVersion,
            chainVia:             [],
            isDev:                parent.isDev || false,
          });
          break;
        }
      }
    }
  }

  return paths;
}

/**
 * Walk an intermediate chain to find the range the final package in the chain
 * declares for `childName`.
 *
 * Example: resolveChainChildRange('webpack', '5.99.0', ['enhanced-resolve'], 'fast-uri')
 *   → fetches webpack@5.99.0 → gets enhanced-resolve range
 *   → fetches latest enhanced-resolve satisfying that range
 *   → returns the fast-uri range that version declares
 *
 * Returns the child range string, or null if the chain cannot be resolved.
 */
async function resolveChainChildRange(rootName, rootVersion, intermediates, childName) {
  let currentDeps = await getVersionDeps(rootName, rootVersion);
  if (!currentDeps) return null;

  for (const intermediate of intermediates) {
    const nextRange = currentDeps.dependencies[intermediate] || currentDeps.peerDependencies[intermediate];
    if (!nextRange) return null;

    // Find the latest published version of intermediate that satisfies nextRange
    const allVersions = await getPublishedVersions(intermediate);
    if (!allVersions) return null;

    const latest = allVersions
      .filter(v => semver.valid(v) && semver.satisfies(v, nextRange))
      .sort((a, b) => semver.rcompare(a, b))[0];
    if (!latest) return null;

    currentDeps = await getVersionDeps(intermediate, latest);
    if (!currentDeps) return null;
  }

  return currentDeps.dependencies[childName] || currentDeps.peerDependencies[childName] || null;
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
    item._parentExplorationRan = true; // stamped before await so manual-review.md always sees it
    const paths = await findParentUpgradePaths(item);
    process.stdout.write('.');

    if (paths.length === 0) continue;

    item.parentUpgradePaths = paths;
    item.phase              = 'B';

    const parentSummary = paths.map(p => {
      const via = p.chainVia && p.chainVia.length > 0
        ? ` (via ${p.chainVia.join(' → ')})`
        : '';
      return `\`${p.parent}\` ${p.parentAllowedRange} → ${p.parentUpgradeVersion}${via}`;
    }).join(', ');
    const childSummary = paths.map(p => p.childDeclaredRange).join(', ');

    item.justification =
      `MAJOR_BUMP resolved via parent upgrade: ${parentSummary}. ` +
      `Upgraded chain declares \`${item.libraryName}@${childSummary}\`. ` +
      `Verify: run \`npm install --package-lock-only\` and confirm ${item.libraryName} resolves to >=${item.recommendedVersion}.`;
  }

  process.stdout.write(' done\n');
}

module.exports = { findParentUpgradePaths, exploreParentUpgrades };
