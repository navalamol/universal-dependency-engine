'use strict';

const semver = require('semver');
const { getPublishedVersions, getManifest } = require('./registry');
const { simulate } = require('./simulator');
const { computeSecurityDelta } = require('../../core/security-delta');

// Cap versions inspected per parent per level; guardrail from REMEDIATION_CAPABILITY_ROADMAP §7.
const CANDIDATE_LIMIT = 10;
// Max depth for recursive chain exploration (guardrail §7).
const MAX_DEPTH       = 5;
// Max npm simulations per exploreParentUpgrades run (guardrail §7).
const MAX_SIMULATIONS = 20;

/**
 * Recursively walk an intermediate chain to find the range the final package
 * in the chain declares for `childName`, exploring multiple candidate versions
 * at each intermediate hop rather than always picking the latest.
 *
 * Returns a range string only when that range covers `fixVersion` (i.e.
 * `semver.intersects(range, '>=' + fixVersion)` is true). This ensures the
 * recursive exploration skips intermediates that don't lead to a fix, rather
 * than returning the first non-null range regardless of whether it helps.
 *
 * Guardrails applied (REMEDIATION_CAPABILITY_ROADMAP §7):
 *   - Cycle detection        : abort branch if (pkg, version) already visited on this branch
 *   - Depth limit            : ctx.maxDepth  (default MAX_DEPTH = 5)
 *   - Candidate limit        : CANDIDATE_LIMIT versions per level, semver-descending
 *   - Duplicate-state dedup  : registry.js per-run manifest cache prevents redundant fetches;
 *                              no separate graph-state map needed at this layer
 *   - Deterministic ordering : semver descending before slicing to CANDIDATE_LIMIT
 *
 * @param {string}   currentName     package currently being inspected
 * @param {string}   currentVersion  version of that package
 * @param {string[]} chain           remaining intermediates before childName
 * @param {string}   childName       the vulnerable package name
 * @param {string}   fixVersion      minimum safe version for childName
 * @param {object}   ctx             guardrail state
 * @param {Set}      ctx.visited     (pkg@version) pairs visited on this branch
 * @param {number}   ctx.depth       current recursion depth
 * @param {number}   ctx.maxDepth    hard depth limit
 * @returns {Promise<string|null>} childName's declared range (covering fixVersion), or null
 */
async function recursiveResolveChainChildRange(currentName, currentVersion, chain, childName, fixVersion, ctx) {
  if (ctx.depth >= ctx.maxDepth) return null;

  // Cycle detection: same (pkg, version) already on this branch path
  const nodeKey = `${currentName}@${currentVersion}`;
  if (ctx.visited.has(nodeKey)) return null;

  // Clone visited for this branch so sibling branches are unaffected
  const branchVisited = new Set(ctx.visited);
  branchVisited.add(nodeKey);

  const manifest = await getManifest(currentName, currentVersion);
  if (!manifest) return null;

  if (chain.length === 0) {
    // currentName is the direct parent of childName; check its declared range
    const rawRange = manifest.dependencies[childName] || manifest.peerDependencies[childName];
    if (!rawRange) return null;
    // Only propagate this range upward if it actually covers the fix version
    let covers = false;
    try { covers = semver.intersects(rawRange, '>=' + fixVersion); } catch {}
    return covers ? rawRange : null;
  }

  const nextPkg   = chain[0];
  const nextRange = manifest.dependencies[nextPkg] || manifest.peerDependencies[nextPkg];
  if (!nextRange) return null;

  const allVersions = await getPublishedVersions(nextPkg);
  if (!allVersions) return null;

  // Deterministic: semver descending; bounded by CANDIDATE_LIMIT (guardrail §7)
  const candidates = allVersions
    .filter(v => semver.valid(v) && semver.satisfies(v, nextRange))
    .sort((a, b) => semver.rcompare(a, b))
    .slice(0, CANDIDATE_LIMIT);

  for (const cv of candidates) {
    const range = await recursiveResolveChainChildRange(
      nextPkg, cv, chain.slice(1), childName, fixVersion,
      { visited: branchVisited, depth: ctx.depth + 1, maxDepth: ctx.maxDepth }
    );
    // range is non-null only if it covers fixVersion (checked at the leaf)
    if (range) return range;
  }

  return null;
}

/**
 * For a MAJOR_BUMP Phase C item, walk each root parent's published versions
 * (within the semver range the project already allows) and find the latest
 * parent version whose declared dependency on the vulnerable child covers the
 * fix version.
 *
 * Handles both direct and indirect chains:
 *   Direct  (chainVia absent): rootDep → vulnerableChild
 *   Indirect (chainVia present): rootDep → intermediate(s) → vulnerableChild
 *
 * For indirect chains, uses recursiveResolveChainChildRange to explore
 * multiple candidate versions at each intermediate hop (Step G).
 *
 * The check: semver.intersects(childRange, '>=' + fixVersion)
 *   true  → the parent's declared range can resolve to a safe child version
 *   false → the parent still pins the vulnerable major
 *
 * @param {object} item  PhasedItem
 * @param {object} opts  { maxDepth?: number }
 * @returns {Promise<object[]>} array of path objects (one per viable parent)
 */
async function findParentUpgradePaths(item, opts) {
  if (!item.rootParents || item.rootParents.length === 0) return [];
  if (!item.recommendedVersion) return [];

  const fixVersion = item.recommendedVersion;
  const childName  = item.libraryName;
  const maxDepth   = (opts && opts.maxDepth) || MAX_DEPTH;
  const paths      = [];

  for (const parent of item.rootParents) {
    const { name: parentName, range: allowedRange, chainVia } = parent;

    const allVersions = await getPublishedVersions(parentName);
    if (!allVersions) continue;

    // Only consider versions the project already allows (within declared range).
    // Sort descending so we find the latest compatible upgrade first.
    const candidates = allVersions
      .filter(v => semver.valid(v) && semver.satisfies(v, allowedRange))
      .sort((a, b) => semver.rcompare(a, b))
      .slice(0, CANDIDATE_LIMIT);

    if (candidates.length === 0) continue;

    if (chainVia && chainVia.length > 0) {
      // Indirect chain: rootDep → intermediate(s) → vulnerableChild
      // Use recursive exploration to try multiple versions at each intermediate
      // hop (Step G), bounded by all 9 guardrails (depth, candidate limit,
      // cycle detection, deterministic ordering, registry cache).
      // recursiveResolveChainChildRange only returns non-null when the range
      // at the end of the chain covers fixVersion, so no extra semver check needed.
      for (const candidateVersion of candidates) {
        const childRange = await recursiveResolveChainChildRange(
          parentName, candidateVersion, chainVia, childName, fixVersion,
          { visited: new Set(), depth: 0, maxDepth }
        );
        if (!childRange) continue;

        paths.push({
          parent:               parentName,
          parentAllowedRange:   allowedRange,
          parentUpgradeVersion: candidateVersion,
          childDeclaredRange:   childRange,
          childFixVersion:      fixVersion,
          chainVia:             chainVia,
          isDev:                parent.isDev || false,
          manifestVerified:     true,
        });
        break;
      }
    } else {
      // Direct parent: rootDep directly declares vulnerableChild
      for (const candidateVersion of candidates) {
        const deps = await getManifest(parentName, candidateVersion);
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
            manifestVerified:     true,
          });
          break;
        }
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
 * @param {string}   packageJsonPath
 * @param {string}   lockPath
 * @param {object}   opts        { maxDepth?: number, maxSimulations?: number }
 */
async function exploreParentUpgrades(phasedPlan, ecosystem, packageJsonPath, lockPath, opts) {
  if (ecosystem !== 'npm') return;

  const candidates = phasedPlan.filter(
    i => i.phase === 'C' && i.upgradeType === 'MAJOR_BUMP' &&
         i.rootParents && i.rootParents.length > 0
  );

  if (candidates.length === 0) return;

  const maxDepth       = (opts && opts.maxDepth)       || MAX_DEPTH;
  const maxSimulations = (opts && opts.maxSimulations)  || MAX_SIMULATIONS;
  // Shared simulation counter across all items — fail-open when limit reached (guardrail §7)
  const simCount = { value: 0 };

  process.stdout.write('  Checking parent upgrade paths');

  for (const item of candidates) {
    item._parentExplorationRan = true; // stamped before await so manual-review.md always sees it
    const paths = await findParentUpgradePaths(item, { maxDepth });
    process.stdout.write('.');

    if (paths.length === 0) continue;

    // Attempt simulation-verification for each manifest-verified path.
    // Requires --package-json to be set; skipped (stays INFERRED) when unavailable.
    // Simulation limit (guardrail §7): fail-open — paths stay INFERRED when limit hit.
    if (packageJsonPath) {
      for (const p of paths) {
        if (simCount.value >= maxSimulations) break; // limit reached; remaining paths stay INFERRED
        simCount.value++;

        const simResults = simulate(packageJsonPath, lockPath || null, [{
          name: p.parent,
          from: p.parentAllowedRange,
          to:   p.parentUpgradeVersion,
        }]);
        const r = simResults[0];
        if (r && r.success && !r.timedOut && !r.limitExceeded) {
          const resolved = r.resolvedVersions.get(item.libraryName);
          if (resolved && semver.gte(resolved, item.recommendedVersion)) {
            p.simulationVerified = true;
          }
          // Attach security delta so path ranker can penalise regressions (Item 6)
          p._simulatedResolvedVersions = r.resolvedVersions;
        }
      }
    }

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

module.exports = { findParentUpgradePaths, exploreParentUpgrades, recursiveResolveChainChildRange };
