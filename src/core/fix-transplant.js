'use strict';

// D3.2 — Fix Transplant Engine.
// Locates upstream fix metadata from registry manifest data and assesses
// whether the fix can be safely backported to the installed version.
// Does NOT exec git or npm — callers inject manifest data via opts.manifest.

const semver = require('semver');

const TRANSPLANT_CONFIDENCE = Object.freeze({
  HIGH:    'HIGH',    // fix version in registry + changelog reference
  MEDIUM:  'MEDIUM',  // fix version in registry, no changelog
  LOW:     'LOW',     // inferred from version bump pattern only
  UNKNOWN: 'UNKNOWN',
});

const BACKPORT_STATUS = Object.freeze({
  BACKPORTABLE:     'BACKPORTABLE',     // same major, patch-level diff expected
  RISKY:            'RISKY',            // minor-version gap > threshold or changelog missing
  NOT_BACKPORTABLE: 'NOT_BACKPORTABLE', // major version bump required
  UNKNOWN:          'UNKNOWN',          // cannot determine from available data
});

/**
 * Locate upstream fix metadata from available data.
 * Network calls are the caller's responsibility — inject result via opts.manifest.
 *
 * @param {string} pkgName
 * @param {string} installedVersion
 * @param {string} fixVersion
 * @param {object} [opts]
 * @param {object} [opts.manifest]       npm registry manifest for fixVersion
 * @param {string} [opts.repositoryUrl]  override repository URL
 * @returns {UpstreamFixInfo}
 */
function locateUpstreamFix(pkgName, installedVersion, fixVersion, opts = {}) {
  const { manifest = null, repositoryUrl = null } = opts;

  const rawRepo = repositoryUrl
    || (manifest && manifest.repository && (
          typeof manifest.repository === 'string'
            ? manifest.repository
            : manifest.repository.url
        ))
    || null;

  const cleanRepo = rawRepo
    ? rawRepo.replace(/^git\+/, '').replace(/\.git$/, '')
    : null;

  const changelogEntry = (manifest && manifest.changelog) || null;

  const confidence = changelogEntry
    ? TRANSPLANT_CONFIDENCE.HIGH
    : cleanRepo
      ? TRANSPLANT_CONFIDENCE.MEDIUM
      : TRANSPLANT_CONFIDENCE.LOW;

  return {
    pkgName,
    installedVersion,
    fixVersion,
    repositoryUrl:    cleanRepo,
    changelogEntry,
    confidence,
    manifestProvided: !!manifest,
  };
}

/**
 * Assess whether the fix can be safely backported to the installed version.
 *
 * @param {string} installedVersion
 * @param {string} fixVersion
 * @param {object} [opts]
 * @param {number} [opts.maxMinorGap=2]
 * @returns {BackportAssessment}
 */
function assessBackport(installedVersion, fixVersion, opts = {}) {
  const { maxMinorGap = 2 } = opts;

  const installed = semver.valid(semver.coerce(installedVersion));
  const fix       = semver.valid(semver.coerce(fixVersion));

  if (!installed || !fix) {
    return { status: BACKPORT_STATUS.UNKNOWN, reason: 'Could not parse one or both versions' };
  }

  const diff = semver.diff(installed, fix);

  if (diff === 'major' || diff === 'premajor') {
    return {
      status:      BACKPORT_STATUS.NOT_BACKPORTABLE,
      reason:      `Major version bump (${installedVersion} → ${fixVersion}) — backport requires API-compat work`,
      versionDiff: diff,
    };
  }

  const instP    = semver.parse(installed);
  const fixP     = semver.parse(fix);
  const minorGap = Math.abs(fixP.minor - instP.minor);

  if (minorGap > maxMinorGap) {
    return {
      status:      BACKPORT_STATUS.RISKY,
      reason:      `Minor version gap of ${minorGap} (threshold: ${maxMinorGap}) — backport may require intermediate changes`,
      versionDiff: diff,
      minorGap,
    };
  }

  return {
    status:      BACKPORT_STATUS.BACKPORTABLE,
    reason:      `Same-major, small diff (${installedVersion} → ${fixVersion}) — minimal changeset expected`,
    versionDiff: diff || 'patch',
    minorGap,
  };
}

/**
 * Build a complete transplant plan combining upstream info + backport assessment.
 *
 * @param {string} pkgName
 * @param {string} installedVersion
 * @param {string} fixVersion
 * @param {object} [opts]
 * @returns {TransplantPlan}
 */
function buildTransplantPlan(pkgName, installedVersion, fixVersion, opts = {}) {
  const upstream  = locateUpstreamFix(pkgName, installedVersion, fixVersion, opts);
  const backport  = assessBackport(installedVersion, fixVersion, opts);

  const recommended =
    backport.status === BACKPORT_STATUS.BACKPORTABLE   ? 'BACKPORT'       :
    backport.status === BACKPORT_STATUS.NOT_BACKPORTABLE ? 'FORK_OR_MIGRATE' :
    'REVIEW_REQUIRED';

  return { pkgName, installedVersion, fixVersion, upstream, backport, recommended };
}

module.exports = {
  TRANSPLANT_CONFIDENCE,
  BACKPORT_STATUS,
  locateUpstreamFix,
  assessBackport,
  buildTransplantPlan,
};
