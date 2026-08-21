'use strict';

// D3.5 — Licensing gate.
// Checks package licenses before patching or forking.
// Produces LICENSE_BLOCKED outcome (already defined in evidence-model.js OUTCOMES).
// Network calls are the caller's responsibility — inject registry manifest via opts.manifest.

// SPDX identifiers known to be copyleft (triggers REVIEW or BLOCKED for fork/patch)
const COPYLEFT_LICENSES = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'LGPL-2.0', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'EUPL-1.1', 'EUPL-1.2',
  'MPL-2.0',
  'CDDL-1.0',
  'EPL-1.0', 'EPL-2.0',
  'SSPL-1.0',
]);

const PERMISSIVE_LICENSES = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'WTFPL',
]);

const LICENSE_DECISION = Object.freeze({
  ALLOWED: 'ALLOWED',
  BLOCKED: 'BLOCKED',
  REVIEW:  'REVIEW',   // copyleft — requires legal sign-off before patching/forking
  UNKNOWN: 'UNKNOWN',  // no license information available
});

/**
 * Extract a license identifier string from an npm registry manifest.
 *
 * @param {object|null} manifest
 * @returns {string|null}
 */
function extractLicense(manifest) {
  if (!manifest) return null;
  const lic = manifest.license;
  if (typeof lic === 'string') return lic.trim() || null;
  if (lic && typeof lic === 'object') return lic.type || null;
  return null;
}

/**
 * Classify a license identifier against patching/forking policy.
 *
 * @param {string|null} license   SPDX identifier (or null)
 * @param {object} [policy]
 * @param {string[]} [policy.blockedLicenses]    SPDX ids that are always blocked
 * @param {string[]} [policy.allowedLicenses]    SPDX ids that are explicitly allowed
 * @param {boolean}  [policy.blockCopyleft=true] treat copyleft as REVIEW (not BLOCKED)
 * @returns {{ decision: string, reason: string }}
 */
function checkLicenseCompatibility(license, policy = {}) {
  const {
    blockedLicenses = [],
    allowedLicenses = [],
    blockCopyleft   = true,
  } = policy;

  if (!license) {
    return { decision: LICENSE_DECISION.UNKNOWN, reason: 'No license information available' };
  }

  // Strip expression wrappers like "(MIT AND ISC)" → "MIT AND ISC" — take first token
  const norm = license.replace(/[()]/g, '').split(/\s+AND\s+|\s+OR\s+/i)[0].trim();

  if (blockedLicenses.includes(norm)) {
    return { decision: LICENSE_DECISION.BLOCKED, reason: `License "${norm}" is in the organisation blocked list` };
  }

  if (allowedLicenses.length > 0 && allowedLicenses.includes(norm)) {
    return { decision: LICENSE_DECISION.ALLOWED, reason: `License "${norm}" is in the organisation allowed list` };
  }

  if (PERMISSIVE_LICENSES.has(norm)) {
    return { decision: LICENSE_DECISION.ALLOWED, reason: `License "${norm}" is a known permissive license` };
  }

  if (COPYLEFT_LICENSES.has(norm)) {
    return blockCopyleft
      ? { decision: LICENSE_DECISION.REVIEW, reason: `License "${norm}" is copyleft — legal review required before patching or forking` }
      : { decision: LICENSE_DECISION.ALLOWED, reason: `License "${norm}" is copyleft but blockCopyleft policy is disabled` };
  }

  return { decision: LICENSE_DECISION.REVIEW, reason: `License "${norm}" is not in a known SPDX category — legal review recommended` };
}

/**
 * Evaluate the license gate for a PhasedItem.
 *
 * @param {object} item           PhasedItem
 * @param {object} [opts]
 * @param {object} [opts.manifest]  registry manifest (injected by caller)
 * @param {object} [opts.policy]    license policy
 * @returns {LicenseGateResult}
 */
function evaluateLicenseGate(item, opts = {}) {
  const { manifest = null, policy = {} } = opts;
  const license = extractLicense(manifest);
  const { decision, reason } = checkLicenseCompatibility(license, policy);

  return {
    pkgName:          item.libraryName,
    version:          item.currentVersion,
    license,
    decision,
    reason,
    outcome:          decision === LICENSE_DECISION.BLOCKED ? 'LICENSE_BLOCKED' : null,
    manifestProvided: !!manifest,
  };
}

module.exports = {
  COPYLEFT_LICENSES,
  PERMISSIVE_LICENSES,
  LICENSE_DECISION,
  extractLicense,
  checkLicenseCompatibility,
  evaluateLicenseGate,
};
