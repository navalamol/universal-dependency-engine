'use strict';

const semver = require('semver');

// Phase A: 95-100% confidence — semver-compatible patch/minor, single version, low risk
// Phase B: 60-95% confidence  — forced override, parent upgrade needed, multi-version present
// Phase C: <60% confidence    — major version bump, no fix, compatibility concerns

const PHASE_META = {
  A: {
    label: 'High Confidence',
    confidence: '95-100%',
    description: 'Semver-compatible patch/minor upgrade. Single version. Safe to auto-apply.',
  },
  B: {
    label: 'Low Confidence',
    confidence: '60-95%',
    description: 'Requires review before applying. Parent upgrade may be preferred.',
  },
  C: {
    label: 'Prone to Error',
    confidence: '<60%',
    description: 'Compatibility risk. Manual review and justification required before applying.',
  },
};

/**
 * Classify a resolution item into Phase A, B, or C.
 */
function classifyPhase(item, allItems) {
  const { upgradeType, libraryName, currentVersion } = item;

  if (upgradeType === 'NO_FIX')     return 'C';
  if (upgradeType === 'MAJOR_BUMP') return 'C';

  // SAFE — check for multi-version conflict
  const sameNameItems = allItems.filter(i => i.libraryName === libraryName);
  if (sameNameItems.length > 1) {
    const majors = new Set(sameNameItems.map(i => semver.major(i.currentVersion)));
    if (majors.size > 1) {
      // Multiple major versions — a single flat override cannot cover both.
      // May be promotable to Phase B if parents are disjoint (checked in promoteMultiMajorToPhaseB).
      return 'C';
    }
    return 'B';
  }

  return 'A';
}

/**
 * Annotate each item in the resolution plan with phase, justification, and
 * optional dep-tree enrichments (probableFalsePositive, rangeViolation).
 *
 * @param {object[]} resolutionPlan
 * @param {Map}      [depTree]  - from lock-parser.parseLockFile(); optional
 */
function applyPhases(resolutionPlan, depTree) {
  let result = resolutionPlan.map(item => {
    let phase = classifyPhase(item, resolutionPlan);
    let justification = buildJustification(item, phase, resolutionPlan);
    const extra = {};

    if (depTree) {
      // Consumer range check — if any declared consumer range does NOT satisfy
      // the fix version, downgrade Phase A → B.
      if (phase === 'A' && item.recommendedVersion) {
        const violation = findRangeViolation(item.libraryName, item.recommendedVersion, depTree);
        if (violation) {
          phase = 'B';
          justification =
            `Consumer \`${violation.consumer}\` declares range \`${violation.range}\` which does not ` +
            `satisfy fix version ${item.recommendedVersion}. Override may not flow through — ` +
            `consider upgrading ${violation.consumer} instead.`;
          extra.rangeViolation = violation;
        }
      }

      // Phase B → A promotion — if dep tree confirms all consumer ranges are
      // compatible with the fix, same-major multi-instance items are safe to auto-apply.
      // Guard: only applies to items that were Phase B from classifyPhase (multi-instance),
      // never to items just downgraded from A (those carry rangeViolation).
      if (phase === 'B' && !extra.rangeViolation && item.recommendedVersion) {
        const violation = findRangeViolation(item.libraryName, item.recommendedVersion, depTree);
        if (!violation) {
          phase = 'A';
          const cveIds = item.cves.map(c => c.id).join(', ');
          const sameNames = resolutionPlan.filter(i => i.libraryName === item.libraryName);
          const fromMajor = semver.major(item.currentVersion);
          justification =
            `Multiple ${item.libraryName} instances (${sameNames.map(i => i.currentVersion).join(', ')}) — ` +
            `all consumer ranges satisfy ${item.recommendedVersion}. Promoted to Phase A. ` +
            `Same-major patch upgrade (${fromMajor}.x). CVEs: ${cveIds}.`;
        }
      }

      // Dev classification — flag NO_FIX items where every lock-file instance is dev: true.
      if (item.upgradeType === 'NO_FIX') {
        const entries = depTree.get(item.libraryName) || [];
        if (entries.length > 0 && entries.every(e => e.dev === true)) {
          extra.probableFalsePositive = true;
          justification =
            `All dependency chains are build/dev-only. Probable false positive — ` +
            `confirm with \`npm ls ${item.libraryName} --prod\`. ` + justification;
        }
      }
    }

    return { ...item, phase, justification, ...extra };
  });

  // Nested override promotion — attempt to move multi-major SAFE conflicts from Phase C → Phase B
  if (depTree) {
    result = promoteMultiMajorToPhaseB(result, depTree);
  }

  return result;
}

/**
 * For multi-major SAFE conflicts (currently Phase C), check whether the dep tree
 * allows generating safe parent-scoped nested overrides.
 *
 * Safe = no parent package name appears in more than one major-version consumer group.
 * If safe, promotes all items in the group to Phase B and attaches nestedOverrides map.
 */
function promoteMultiMajorToPhaseB(phasedItems, depTree) {
  // Collect Phase C SAFE candidates grouped by library name
  const groups = new Map();
  for (const item of phasedItems) {
    if (item.phase === 'C' && item.upgradeType === 'SAFE') {
      if (!groups.has(item.libraryName)) groups.set(item.libraryName, []);
      groups.get(item.libraryName).push(item);
    }
  }

  const promotions = new Map(); // libraryName → nestedOverrides map

  for (const [libraryName, items] of groups) {
    if (items.length < 2) continue;

    // Partition dep tree entries by major version of each conflict item
    const byMajor = new Map(); // major (number) → { fixVersion, parentNames: Set }
    let canPromote = true;

    for (const item of items) {
      const major = semver.major(item.currentVersion);
      const entries = (depTree.get(libraryName) || [])
        .filter(e => semver.valid(e.resolvedVersion) && semver.major(e.resolvedVersion) === major);

      const parentNames = new Set(entries.flatMap(e => e.parents.map(p => p.name)));

      if (parentNames.size === 0) {
        // Package is in the report but not found as a transitive dep in this lock file.
        // Can't generate safe nested overrides without knowing parents.
        canPromote = false;
        break;
      }

      byMajor.set(major, { fixVersion: item.recommendedVersion, parentNames });
    }

    if (!canPromote || byMajor.size < 2) continue;

    // Check for parent name overlap between any two major groups
    const majorGroups = [...byMajor.values()];
    let hasOverlap = false;
    outer: for (let i = 0; i < majorGroups.length; i++) {
      for (let j = i + 1; j < majorGroups.length; j++) {
        for (const name of majorGroups[i].parentNames) {
          if (majorGroups[j].parentNames.has(name)) {
            hasOverlap = true;
            break outer;
          }
        }
      }
    }

    if (hasOverlap) continue; // same parent name appears in both chains — unsafe to key by name alone

    // Generate nested overrides: { "parentPkg": { "conflictedPkg": "fixVersion" } }
    const nested = {};
    for (const { fixVersion, parentNames } of byMajor.values()) {
      for (const parentName of parentNames) {
        if (!nested[parentName]) nested[parentName] = {};
        nested[parentName][libraryName] = fixVersion;
      }
    }

    promotions.set(libraryName, nested);
  }

  if (promotions.size === 0) return phasedItems;

  return phasedItems.map(item => {
    const nested = promotions.get(item.libraryName);
    if (!nested || item.phase !== 'C' || item.upgradeType !== 'SAFE') return item;

    const summary = Object.entries(nested)
      .map(([parent, deps]) => `${parent} → ${Object.values(deps).join(', ')}`)
      .join('; ');

    return {
      ...item,
      phase: 'B',
      nestedOverrides: nested,
      justification:
        `Multi-major conflict (${item.currentVersion}). Nested parent-scoped overrides generated — ` +
        `${summary}. Review parent version assumptions before applying.`,
    };
  });
}

/**
 * Find the first consumer whose declared range does not satisfy recommendedVersion.
 * Returns { consumer, range } or null.
 */
function findRangeViolation(libraryName, recommendedVersion, depTree) {
  const entries = depTree.get(libraryName) || [];
  for (const entry of entries) {
    for (const parent of entry.parents) {
      try {
        if (!semver.satisfies(recommendedVersion, parent.range)) {
          return { consumer: parent.name, range: parent.range };
        }
      } catch {
        // Unknown range format (dist-tag, URL, etc.) — skip, don't downgrade
      }
    }
  }
  return null;
}

function buildJustification(item, phase, allItems) {
  const { upgradeType, libraryName, currentVersion, recommendedVersion, cves } = item;
  const cveIds = cves.map(c => c.id).join(', ');

  if (phase === 'A') {
    const fromMajor = semver.major(currentVersion);
    return `Same-major patch upgrade (${fromMajor}.x). CVEs: ${cveIds}. Override is safe and reversible.`;
  }

  if (phase === 'B') {
    const sameNameItems = allItems.filter(i => i.libraryName === libraryName);
    return `Multiple ${libraryName} versions present (${sameNameItems.map(i => i.currentVersion).join(', ')}). Highest fix (${recommendedVersion}) chosen. Verify no consumers rely on an older API.`;
  }

  if (phase === 'C') {
    if (upgradeType === 'MAJOR_BUMP') {
      const fromMajor = semver.major(currentVersion);
      const toMajor   = recommendedVersion ? semver.major(recommendedVersion) : '?';
      return `Major version jump ${fromMajor} → ${toMajor} for ${libraryName}. No same-major fix available. Verify API compatibility before applying. CVEs: ${cveIds}.`;
    }

    if (upgradeType === 'NO_FIX') {
      return `No published fix for ${libraryName}@${currentVersion}. Assess reachability: if only used at build/test time, classify as false positive. CVEs: ${cveIds}.`;
    }

    // Multi-version conflict (no dep tree, or parents overlap — stays Phase C)
    const sameNameItems = allItems.filter(i => i.libraryName === libraryName);
    const versions = sameNameItems.map(i => `${i.currentVersion}→${i.recommendedVersion}`).join(', ');
    return `Multiple major version lines of ${libraryName} in tree (${versions}). Parent name overlap prevents safe nested overrides. Run \`npm ls ${libraryName}\` to trace chains, then apply parent-scoped overrides manually.`;
  }

  return '';
}

module.exports = { PHASE_META, classifyPhase, applyPhases };
