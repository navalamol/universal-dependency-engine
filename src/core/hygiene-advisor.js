'use strict';

// D1B — Dependency hygiene advisor.
// Identifies hygiene issues beyond active CVEs:
//   - Unused devDependencies (declared but not referenced in scripts or source)
//   - Retirement signals (deprecated flag in registry metadata)
//   - Preventive upgrade opportunities (non-vulnerable packages with available patches)
//
// RULES:
//   - No silent removal — all findings carry evidence and confidence
//   - Recommendations only — no auto-application without explicit opt-in
//   - Preventive changes must use separate PRs (never mixed with CVE fixes)

const semver = require('semver');

// ─── Hygiene finding types ────────────────────────────────────────────────────

const HYGIENE_TYPE = Object.freeze({
  UNUSED_DEV_DEP:        'UNUSED_DEV_DEP',          // devDep not used in scripts/source
  DEPRECATED:            'DEPRECATED',               // registry deprecated flag set
  PREVENTIVE_UPGRADE:    'PREVENTIVE_UPGRADE',       // non-vulnerable, newer patch/minor exists
  GIT_DEP:               'GIT_DEP',                  // installed from git URL, not registry
  BRANCH_DEP:            'BRANCH_DEP',               // installed from branch ref
});

const HYGIENE_CONFIDENCE = Object.freeze({
  HIGH:   0.85,
  MEDIUM: 0.65,
  LOW:    0.40,
});

// ─── detectUnusedDevDeps ──────────────────────────────────────────────────────

/**
 * Identify devDependencies that are not referenced in package.json scripts.
 * Confidence is MEDIUM because scripts don't cover all usage patterns (e.g. .npmrc,
 * webpack configs, test helpers). Only flags as unused if absent from all scripts.
 *
 * @param {object} packageJson  - parsed package.json
 * @returns {object[]}  array of HygieneFinding
 */
function detectUnusedDevDeps(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];

  const devDeps = Object.keys(packageJson.devDependencies || {});
  if (devDeps.length === 0) return [];

  const scripts  = Object.values(packageJson.scripts || {}).join(' ');
  const findings = [];

  for (const name of devDeps) {
    if (!scripts.includes(name)) {
      findings.push({
        type:       HYGIENE_TYPE.UNUSED_DEV_DEP,
        package:    name,
        evidence:   'Package name not found in any package.json script command',
        confidence: HYGIENE_CONFIDENCE.MEDIUM,
        recommendation: `Verify ${name} is still needed. If unused, run 'npm uninstall --save-dev ${name}'.`,
        autoApplicable: false,
      });
    }
  }

  return findings;
}

// ─── detectRetirementSignals ──────────────────────────────────────────────────

/**
 * Flag packages whose registry metadata shows retirement signals:
 *   - deprecated field set in npm registry
 *   - version range declared as deprecated
 *
 * @param {object[]} entries        - LibraryEntry[] or any array with { libraryName, currentVersion }
 * @param {Map}      registryMeta   - Map<packageName, { deprecated: string|false, ... }>
 *                                    (populated by caller from registry.getManifest)
 * @returns {object[]}  array of HygieneFinding
 */
function detectRetirementSignals(entries, registryMeta) {
  if (!Array.isArray(entries)) return [];
  const findings = [];

  for (const entry of entries) {
    const meta = registryMeta && registryMeta.get && registryMeta.get(entry.libraryName);
    if (!meta) continue;

    if (meta.deprecated) {
      findings.push({
        type:       HYGIENE_TYPE.DEPRECATED,
        package:    entry.libraryName,
        version:    entry.currentVersion,
        evidence:   `npm registry deprecated flag: "${meta.deprecated}"`,
        confidence: HYGIENE_CONFIDENCE.HIGH,
        recommendation: `Migrate away from ${entry.libraryName}. Registry message: ${meta.deprecated}`,
        autoApplicable: false,
      });
    }
  }

  return findings;
}

// ─── detectPreventiveUpgrades ─────────────────────────────────────────────────

/**
 * Identify packages that have newer patch or minor versions available but
 * are NOT in the current vulnerability report (i.e. not a CVE fix).
 * These are proactive hygiene upgrades.
 *
 * @param {object[]} entries          - LibraryEntry[] from a vulnerability report
 * @param {object[]} allInstalledPkgs - Array of { name, version } from depTree or lockfile
 * @param {Map}      availableVersions - Map<packageName, string[]> of versions from registry
 * @returns {object[]} HygieneFinding[]
 */
function detectPreventiveUpgrades(entries, allInstalledPkgs, availableVersions) {
  if (!Array.isArray(allInstalledPkgs)) return [];

  // Build a set of package names already covered by CVE findings
  const cveCovered = new Set((entries || []).map(e => e.libraryName));

  const findings = [];

  for (const pkg of allInstalledPkgs) {
    // Skip packages already covered by CVE analysis
    if (cveCovered.has(pkg.name)) continue;

    const versions = availableVersions && availableVersions.get && availableVersions.get(pkg.name);
    if (!Array.isArray(versions) || versions.length === 0) continue;

    // Find the latest patch/minor update within the same major
    const currentSemver = semver.coerce(pkg.version);
    if (!currentSemver) continue;

    const sameOrHigher = versions.filter(v => {
      const parsed = semver.coerce(v);
      return parsed &&
        parsed.major === currentSemver.major &&
        semver.gt(parsed, currentSemver);
    });

    if (sameOrHigher.length === 0) continue;

    const latest = sameOrHigher.sort((a, b) => semver.rcompare(semver.coerce(a), semver.coerce(b)))[0];
    const upgradeType = semver.diff(currentSemver, semver.coerce(latest));

    if (upgradeType === 'patch' || upgradeType === 'minor') {
      findings.push({
        type:          HYGIENE_TYPE.PREVENTIVE_UPGRADE,
        package:       pkg.name,
        currentVersion: pkg.version,
        availableVersion: latest,
        upgradeType,
        evidence:      `${upgradeType} upgrade available: ${pkg.version} → ${latest}`,
        confidence:    HYGIENE_CONFIDENCE.HIGH,
        recommendation: `Consider upgrading ${pkg.name} from ${pkg.version} to ${latest} as a preventive measure.`,
        autoApplicable: false, // preventive changes always require review
      });
    }
  }

  return findings;
}

// ─── detectGitAndBranchDeps ───────────────────────────────────────────────────

/**
 * Identify dependencies installed from git URLs or branch references.
 * These are risky because they bypass registry security and may silently change.
 *
 * @param {object} packageJson  - parsed package.json
 * @returns {object[]} HygieneFinding[]
 */
function detectGitAndBranchDeps(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];

  const findings = [];
  const allDeps  = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  for (const [name, spec] of Object.entries(allDeps)) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('git://') || /^[^@#\s]+\/[^@#\s]+/.test(spec)) {
      findings.push({
        type:       HYGIENE_TYPE.GIT_DEP,
        package:    name,
        spec,
        evidence:   `Installed from git source: "${spec}"`,
        confidence: HYGIENE_CONFIDENCE.HIGH,
        recommendation: `Replace ${name}'s git source with a registry version for reproducibility and security.`,
        autoApplicable: false,
      });
    } else if (spec.includes('#') && !spec.startsWith('^') && !spec.startsWith('~')) {
      findings.push({
        type:       HYGIENE_TYPE.BRANCH_DEP,
        package:    name,
        spec,
        evidence:   `Installed from branch/commit ref: "${spec}"`,
        confidence: HYGIENE_CONFIDENCE.HIGH,
        recommendation: `Replace ${name}'s branch ref with a pinned registry version.`,
        autoApplicable: false,
      });
    }
  }

  return findings;
}

// ─── analyzeHygiene ───────────────────────────────────────────────────────────

/**
 * Run all hygiene checks and return a combined report.
 *
 * @param {object}   packageJson
 * @param {object[]} entries           - LibraryEntry[] (CVE findings, for de-dup)
 * @param {object}   [opts]
 * @param {Map}      [opts.registryMeta]    - see detectRetirementSignals
 * @param {object[]} [opts.installedPkgs]   - see detectPreventiveUpgrades
 * @param {Map}      [opts.availableVersions] — see detectPreventiveUpgrades
 * @returns {{ findings: object[], summary: object }}
 */
function analyzeHygiene(packageJson, entries, opts = {}) {
  const { registryMeta, installedPkgs, availableVersions } = opts;

  const findings = [
    ...detectUnusedDevDeps(packageJson),
    ...detectRetirementSignals(entries || [], registryMeta || null),
    ...detectPreventiveUpgrades(entries || [], installedPkgs || [], availableVersions || null),
    ...detectGitAndBranchDeps(packageJson),
  ];

  const summary = {
    total:            findings.length,
    byType:           _countByType(findings),
    autoApplicable:   findings.filter(f => f.autoApplicable).length,
    requiresReview:   findings.filter(f => !f.autoApplicable).length,
  };

  return { findings, summary };
}

function _countByType(findings) {
  const out = {};
  for (const f of findings) {
    out[f.type] = (out[f.type] || 0) + 1;
  }
  return out;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  HYGIENE_TYPE,
  HYGIENE_CONFIDENCE,
  detectUnusedDevDeps,
  detectRetirementSignals,
  detectPreventiveUpgrades,
  detectGitAndBranchDeps,
  analyzeHygiene,
};
