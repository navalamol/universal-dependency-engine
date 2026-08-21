'use strict';

// M2.2 — Post-remediation rescan adapter.
// Compares CVE sets from a before-snapshot and an after-snapshot (both LibraryEntry[])
// and classifies the remediation outcome.
//
// Status values (in decreasing evidence quality):
//   RESOLVED_AND_RESCANNED   — rescanned; all targeted CVEs gone
//   RESOLVED_NOT_RESCANNED   — no after-snapshot provided; install succeeded but no rescan
//   INSTALL_VERIFIED_ONLY    — rescanned; CVE data not usable (empty/null after-entries)
//   VERIFICATION_FAILED      — rescanned; one or more targeted CVEs still present

const RESCAN_STATUS = Object.freeze({
  RESOLVED_AND_RESCANNED:  'RESOLVED_AND_RESCANNED',
  RESOLVED_NOT_RESCANNED:  'RESOLVED_NOT_RESCANNED',
  INSTALL_VERIFIED_ONLY:   'INSTALL_VERIFIED_ONLY',
  VERIFICATION_FAILED:     'VERIFICATION_FAILED',
});

/**
 * Build a Set of CVE IDs from a LibraryEntry array, optionally filtered to a
 * specific package name.
 */
function _cveSet(entries, libraryName) {
  const out = new Set();
  for (const entry of entries || []) {
    if (libraryName && entry.libraryName !== libraryName) continue;
    for (const cve of entry.cves || []) {
      if (cve.id) out.add(cve.id);
    }
  }
  return out;
}

/**
 * Classify a single-item rescan outcome.
 *
 * @param {object}    phasedItem        - PhasedItem from the before-run
 * @param {object[]|null} afterEntries  - LibraryEntry[] from a post-remediation rescan;
 *                                        null/undefined means no rescan was performed
 * @param {object}    [opts]
 * @param {string}    [opts.rescanReportFile]
 * @returns {{ status, remainingCveIds, resolvedCveIds, ranAt, rescanReportFile }}
 */
function classifyRescanOutcome(phasedItem, afterEntries, opts = {}) {
  const ranAt = opts.ranAt || new Date().toISOString();

  if (!afterEntries) {
    return {
      status:           RESCAN_STATUS.RESOLVED_NOT_RESCANNED,
      remainingCveIds:  [],
      resolvedCveIds:   [],
      ranAt,
      rescanReportFile: opts.rescanReportFile || null,
    };
  }

  const targetCveIds = new Set((phasedItem.cves || []).map(c => c.id).filter(Boolean));

  if (targetCveIds.size === 0) {
    return {
      status:           RESCAN_STATUS.INSTALL_VERIFIED_ONLY,
      remainingCveIds:  [],
      resolvedCveIds:   [],
      ranAt,
      rescanReportFile: opts.rescanReportFile || null,
    };
  }

  const afterCveSet    = _cveSet(afterEntries, phasedItem.libraryName);
  const remainingCveIds = [...targetCveIds].filter(id => afterCveSet.has(id));
  const resolvedCveIds  = [...targetCveIds].filter(id => !afterCveSet.has(id));

  const status = remainingCveIds.length > 0
    ? RESCAN_STATUS.VERIFICATION_FAILED
    : RESCAN_STATUS.RESOLVED_AND_RESCANNED;

  return {
    status,
    remainingCveIds,
    resolvedCveIds,
    ranAt,
    rescanReportFile: opts.rescanReportFile || null,
  };
}

/**
 * Classify rescan outcomes for an entire phased plan.
 * Returns an array parallel to phasedPlan, each entry a rescan result object.
 *
 * @param {object[]}      phasedPlan
 * @param {object[]|null} afterEntries   - null means no rescan (all items get RESOLVED_NOT_RESCANNED)
 * @param {object}        [opts]
 * @returns {object[]}
 */
function classifyPlanRescanOutcomes(phasedPlan, afterEntries, opts = {}) {
  return phasedPlan.map(item => classifyRescanOutcome(item, afterEntries, opts));
}

module.exports = {
  RESCAN_STATUS,
  classifyRescanOutcome,
  classifyPlanRescanOutcomes,
};
