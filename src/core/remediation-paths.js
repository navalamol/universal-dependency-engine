'use strict';

const semver = require('semver');
const { computeSecurityDelta } = require('./security-delta');

// Decision label taxonomy — REMEDIATION_CAPABILITY_ROADMAP §4
const LABELS = {
  SAFE_ALIGNED:           'SAFE_ALIGNED',
  SAFE_PARENT_UPGRADE:    'SAFE_PARENT_UPGRADE',
  CONTROLLED_OVERRIDE:    'CONTROLLED_OVERRIDE',
  NOT_FIXABLE:            'NOT_FIXABLE',
  NON_RUNTIME_EXPOSURE:   'NON_RUNTIME_EXPOSURE',
  MANUAL_SECURITY_REVIEW: 'MANUAL_SECURITY_REVIEW',
};

// Change Budget tiers — REMEDIATION_CAPABILITY_ROADMAP §5
// Lower tier = smaller blast radius = preferred
const BUDGET_TIERS = {
  LOCKFILE_ONLY:      1,
  DIRECT_RANGE_RELAX: 2,
  PARENT_PATCH:       3,
  PARENT_MINOR:       4,
  PARENT_MAJOR:       5,
  SINGLE_OVERRIDE:    6,
  MULTI_OVERRIDE:     7,
};

const CONFIDENCE_RANK = { VERIFIED: 0, INFERRED: 1, MANUAL: 2 };

/**
 * Build all candidate remediation paths for a single PhasedItem.
 *
 * Path shape:
 * {
 *   type:              'PARENT_UPGRADE' | 'DIRECT_OVERRIDE' | 'NESTED_OVERRIDE' | 'NO_FIX',
 *   confidence:        'VERIFIED' | 'INFERRED' | 'MANUAL',
 *   budgetTier:        number,
 *   budgetLabel:       string,
 *   semverDist:        number,
 *   decisionLabel:     string,
 *   peerConflicts:     string[],
 *   securityDelta:     { introduced: [], fixed: [] } | null,
 *   detail:            object,
 * }
 */
function buildPaths(item, allFindings) {
  const paths = [];

  // 1. Parent upgrade paths (populated by parent-upgrade-explorer.js)
  if (item.parentUpgradePaths && item.parentUpgradePaths.length > 0) {
    for (const p of item.parentUpgradePaths) {
      const confidence = p.simulationVerified ? 'VERIFIED'
                       : p.manifestVerified   ? 'INFERRED' : 'MANUAL';
      const budgetTier = parentBudgetTier(p.parentAllowedRange, p.parentUpgradeVersion);

      // Security delta — computed from resolved versions when simulation ran (Item 6)
      let securityDelta = null;
      if (p._simulatedResolvedVersions && allFindings && allFindings.length) {
        securityDelta = computeSecurityDelta(p._simulatedResolvedVersions, allFindings);
      }

      paths.push({
        type:          'PARENT_UPGRADE',
        confidence,
        budgetTier,
        budgetLabel:   tierLabel(budgetTier),
        semverDist:    versionDist(rangeMin(p.parentAllowedRange), p.parentUpgradeVersion),
        decisionLabel: LABELS.SAFE_PARENT_UPGRADE,
        peerConflicts: [],
        securityDelta,
        detail: {
          parent:               p.parent,
          parentAllowedRange:   p.parentAllowedRange,
          parentUpgradeVersion: p.parentUpgradeVersion,
          childDeclaredRange:   p.childDeclaredRange,
          childFixVersion:      p.childFixVersion,
          chainVia:             p.chainVia || [],
          isDev:                p.isDev || false,
          manifestVerified:     p.manifestVerified || false,
          simulationVerified:   p.simulationVerified || false,
        },
      });
    }
  }

  // 2. Direct override / fix path
  if (item.upgradeType !== 'NO_FIX' && item.recommendedVersion) {
    if (item.upgradeType === 'MAJOR_BUMP') {
      paths.push({
        type:          'DIRECT_OVERRIDE',
        confidence:    'INFERRED',
        budgetTier:    BUDGET_TIERS.SINGLE_OVERRIDE,
        budgetLabel:   tierLabel(BUDGET_TIERS.SINGLE_OVERRIDE),
        semverDist:    versionDist(item.currentVersion, item.recommendedVersion),
        decisionLabel: LABELS.CONTROLLED_OVERRIDE,
        peerConflicts: [],
        securityDelta: null,
        detail: { name: item.libraryName, from: item.currentVersion, to: item.recommendedVersion },
      });
    } else if (item.nestedOverrides) {
      paths.push({
        type:          'NESTED_OVERRIDE',
        confidence:    'INFERRED',
        budgetTier:    BUDGET_TIERS.MULTI_OVERRIDE,
        budgetLabel:   tierLabel(BUDGET_TIERS.MULTI_OVERRIDE),
        semverDist:    versionDist(item.currentVersion, item.recommendedVersion),
        decisionLabel: LABELS.CONTROLLED_OVERRIDE,
        peerConflicts: [],
        securityDelta: null,
        detail: { nestedOverrides: item.nestedOverrides },
      });
    } else if (item.phase === 'A') {
      paths.push({
        type:          'DIRECT_OVERRIDE',
        confidence:    'INFERRED',
        budgetTier:    BUDGET_TIERS.SINGLE_OVERRIDE,
        budgetLabel:   tierLabel(BUDGET_TIERS.SINGLE_OVERRIDE),
        semverDist:    versionDist(item.currentVersion, item.recommendedVersion),
        decisionLabel: LABELS.SAFE_ALIGNED,
        peerConflicts: [],
        securityDelta: null,
        detail: { name: item.libraryName, from: item.currentVersion, to: item.recommendedVersion },
      });
    } else {
      // Phase B without nestedOverrides — plain override
      paths.push({
        type:          'DIRECT_OVERRIDE',
        confidence:    'INFERRED',
        budgetTier:    BUDGET_TIERS.SINGLE_OVERRIDE,
        budgetLabel:   tierLabel(BUDGET_TIERS.SINGLE_OVERRIDE),
        semverDist:    versionDist(item.currentVersion, item.recommendedVersion),
        decisionLabel: LABELS.CONTROLLED_OVERRIDE,
        peerConflicts: [],
        securityDelta: null,
        detail: { name: item.libraryName, from: item.currentVersion, to: item.recommendedVersion },
      });
    }
  }

  // 3. NO_FIX
  if (item.upgradeType === 'NO_FIX') {
    paths.push({
      type:          'NO_FIX',
      confidence:    'MANUAL',
      budgetTier:    99,
      budgetLabel:   'not-fixable',
      semverDist:    0,
      decisionLabel: item.probableFalsePositive ? LABELS.NON_RUNTIME_EXPOSURE : LABELS.NOT_FIXABLE,
      peerConflicts: [],
      securityDelta: null,
      detail:        {},
    });
  }

  return paths;
}

/**
 * Rank paths: VERIFIED > INFERRED > MANUAL, then fewest regressions introduced,
 * then lower budget tier, then lower semver distance.
 */
function rankPaths(paths) {
  return [...paths].sort((a, b) => {
    const cr = (CONFIDENCE_RANK[a.confidence] ?? 99) - (CONFIDENCE_RANK[b.confidence] ?? 99);
    if (cr !== 0) return cr;
    // Penalise paths that introduce security regressions
    const ar = (a.securityDelta ? a.securityDelta.introduced.length : 0);
    const br = (b.securityDelta ? b.securityDelta.introduced.length : 0);
    if (ar !== br) return ar - br;
    const bt = a.budgetTier - b.budgetTier;
    if (bt !== 0) return bt;
    return a.semverDist - b.semverDist;
  });
}

/**
 * Enrich a single item with ranked remediation paths and a decision label.
 * Returns item with: recommendedPath, alternativePaths[], decisionLabel.
 *
 * @param {object}   item
 * @param {object[]} [allFindings]  — LibraryEntry[] passed through to security-delta (optional)
 */
function comparePaths(item, allFindings) {
  const all    = buildPaths(item, allFindings);
  const ranked = rankPaths(all);
  const [recommended, ...alternatives] = ranked;

  let decisionLabel;
  if (item.upgradeType === 'NO_FIX') {
    decisionLabel = item.probableFalsePositive ? LABELS.NON_RUNTIME_EXPOSURE : LABELS.NOT_FIXABLE;
  } else if (item.upgradeType === 'MAJOR_BUMP' && (!item.parentUpgradePaths || item.parentUpgradePaths.length === 0)) {
    decisionLabel = LABELS.MANUAL_SECURITY_REVIEW;
  } else {
    decisionLabel = recommended ? recommended.decisionLabel : LABELS.MANUAL_SECURITY_REVIEW;
  }

  return {
    ...item,
    recommendedPath:  recommended || null,
    alternativePaths: alternatives,
    decisionLabel,
  };
}

/**
 * Apply comparePaths to every item in a phased plan.
 *
 * @param {object[]} phasedPlan
 * @param {object[]} [allFindings]  — original LibraryEntry[] for security-delta cross-check
 */
function enrichWithPaths(phasedPlan, allFindings) {
  return phasedPlan.map(item => comparePaths(item, allFindings));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parentBudgetTier(allowedRange, upgradeVersion) {
  const base = rangeMin(allowedRange);
  if (!semver.valid(base) || !semver.valid(upgradeVersion)) return BUDGET_TIERS.PARENT_MINOR;
  if (semver.major(upgradeVersion) > semver.major(base)) return BUDGET_TIERS.PARENT_MAJOR;
  if (semver.minor(upgradeVersion) === semver.minor(base) &&
      semver.major(upgradeVersion) === semver.major(base)) return BUDGET_TIERS.PARENT_PATCH;
  return BUDGET_TIERS.PARENT_MINOR;
}

function rangeMin(range) {
  try {
    const min = semver.minVersion(range);
    return min ? min.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function versionDist(from, to) {
  if (!semver.valid(from) || !semver.valid(to)) return 99999;
  return Math.abs(semver.major(to) - semver.major(from)) * 10000
       + Math.abs(semver.minor(to) - semver.minor(from)) * 100
       + Math.abs(semver.patch(to) - semver.patch(from));
}

function tierLabel(tier) {
  return {
    [BUDGET_TIERS.LOCKFILE_ONLY]:      'lockfile-only',
    [BUDGET_TIERS.DIRECT_RANGE_RELAX]: 'direct-range-relax',
    [BUDGET_TIERS.PARENT_PATCH]:       'parent-patch-upgrade',
    [BUDGET_TIERS.PARENT_MINOR]:       'parent-minor-upgrade',
    [BUDGET_TIERS.PARENT_MAJOR]:       'parent-major-upgrade',
    [BUDGET_TIERS.SINGLE_OVERRIDE]:    'single-override',
    [BUDGET_TIERS.MULTI_OVERRIDE]:     'multi-override',
  }[tier] || 'unknown';
}

module.exports = { buildPaths, rankPaths, comparePaths, enrichWithPaths, LABELS, BUDGET_TIERS };
