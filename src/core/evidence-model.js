'use strict';

// M2.4 + M2.5 — Canonical evidence model.
// Every Phase A/B/C decision produces one EvidenceBundle describing:
//   - what was decided (outcome + phase)
//   - what was observed (lock-file, registry, dep-chain facts)
//   - what verification ran (build/test) and what it returned
//   - what rescan found after remediation
//   - environmental exposure classification (stubs — populated by D1A)
// Consumers: orchestrator.js, mendfix apply, CI report, SARIF/VEX export.

const SCHEMA_VERSION = '1.0';

// ─── Outcome taxonomy (M2.5) ─────────────────────────────────────────────────
const OUTCOMES = Object.freeze({
  FIXED:                  'FIXED',                  // fix applied, lock/manifest updated
  NOT_AFFECTED:           'NOT_AFFECTED',           // package present but execution path unreachable
  MITIGATED:              'MITIGATED',              // compensating control in place (WAF, network policy)
  PATCHED:                'PATCHED',                // vendor patch applied directly
  FORKED:                 'FORKED',                 // internal fork created under scoped private package
  ACCEPTED_RISK:          'ACCEPTED_RISK',          // risk formally accepted with justification
  LICENSE_BLOCKED:        'LICENSE_BLOCKED',        // license prevents patching or forking
  VERIFICATION_FAILED:    'VERIFICATION_FAILED',    // fix applied but build/test/rescan step failed
  REQUIRES_MIGRATION:     'REQUIRES_MIGRATION',     // major migration needed; no safe in-place path
  NO_SAFE_PATH:           'NO_SAFE_PATH',           // no fix version, no parent upgrade, no alternative
  LLM_SYNTHESIZED_PATCH:  'LLM_SYNTHESIZED_PATCH',  // D3.4 — LLM candidate patch; human approval required
});

// ─── Exposure classification (D1A stubs) ─────────────────────────────────────
// Values populated by D1A; all bundles ship UNKNOWN_EXPOSURE until D1A runs.
const EXPOSURE = Object.freeze({
  RUNTIME_REACHABLE:          'RUNTIME_REACHABLE',
  PRODUCTION_BUNDLED:         'PRODUCTION_BUNDLED',
  BUILD_TIME_EXECUTED:        'BUILD_TIME_EXECUTED',
  CI_EXECUTED:                'CI_EXECUTED',
  TEST_ONLY:                  'TEST_ONLY',
  LOCAL_TOOLING_ONLY:         'LOCAL_TOOLING_ONLY',
  INSTALLED_NOT_USED:         'INSTALLED_NOT_USED',
  NOT_IN_PRODUCTION_ARTIFACT: 'NOT_IN_PRODUCTION_ARTIFACT',
  UNKNOWN_EXPOSURE:           'UNKNOWN_EXPOSURE',
});

// ─── createEvidence ──────────────────────────────────────────────────────────
/**
 * Build a canonical EvidenceBundle from a PhasedItem.
 *
 * @param {object} item       - PhasedItem (output of phases.js + enrichWithConfidence)
 * @param {object} [opts]
 * @param {string} [opts.project]       - project / repo name for traceability
 * @param {string} [opts.reportFile]    - source vulnerability report path
 * @param {string} [opts.provider]      - scanner provider name (mend, snyk, …)
 * @param {string} [opts.ecosystem]     - npm | maven | python | go | dotnet | rust
 * @param {string} [opts.generatedAt]   - ISO timestamp (defaults to now)
 * @returns {EvidenceBundle}
 */
function createEvidence(item, opts = {}) {
  const {
    project     = null,
    reportFile  = null,
    provider    = null,
    ecosystem   = null,
    generatedAt = new Date().toISOString(),
  } = opts;

  // Derive initial outcome from phase + upgradeType
  const outcome = _deriveOutcome(item);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,

    // Identity
    libraryName:     item.libraryName,
    currentVersion:  item.currentVersion,
    fixVersion:      item.recommendedVersion || null,
    ecosystem,
    provider,
    project,
    reportFile,

    // Decision
    phase:       item.phase,
    outcome,
    upgradeType: item.upgradeType,

    // CVEs addressed
    cves: (item.cves || []).map(c => ({
      id:       c.id,
      severity: c.severity || 'UNKNOWN',
      score:    c.score    || null,
    })),

    // Deterministic SemVer facts
    semver: {
      upgradeType:  item.upgradeType,
      justification: item.justification || null,
      rangeViolation: item.rangeViolation
        ? { consumer: item.rangeViolation.consumer, range: item.rangeViolation.range }
        : null,
      registryAdjusted:   item.registryAdjusted   || false,
      registryRequested:  item.registryRequested   || null,
      registryExists:     item.registryExists      != null ? item.registryExists : null,
    },

    // Lock-file / dep-chain facts
    lockFile: {
      depChain:            item.depChain            || [],
      rootParents:         item.rootParents          || [],
      probableFalsePositive: item.probableFalsePositive || false,
    },

    // Human-readable evidence + alternative (from confidence.js)
    humanEvidence:  item.evidence    || null,
    humanAlternative: item.alternative || null,

    // Remediation path chosen (from remediation-paths.js)
    remediationPath: item.recommendedPath
      ? { label: item.decisionLabel || null, path: item.recommendedPath }
      : null,

    // Environmental exposure (D1A — UNKNOWN_EXPOSURE until classifier runs)
    exposure: {
      classification: EXPOSURE.UNKNOWN_EXPOSURE,
      confidence:     null,
      evidenceSources: [],
    },

    // Build/test verification (M2.1 — null until verifier runs)
    verification: null,

    // Post-remediation rescan (M2.2 — null until rescan adapter runs)
    rescan: null,
  };
}

// ─── Outcome derivation ──────────────────────────────────────────────────────
function _deriveOutcome(item) {
  if (item.upgradeType === 'NO_FIX') {
    return item.probableFalsePositive ? OUTCOMES.NOT_AFFECTED : OUTCOMES.NO_SAFE_PATH;
  }
  if (item.upgradeType === 'MAJOR_BUMP') return OUTCOMES.REQUIRES_MIGRATION;
  // SAFE upgrade — outcome is FIXED once applied; stays FIXED at creation time
  // (mergeVerificationResult may downgrade to VERIFICATION_FAILED)
  return OUTCOMES.FIXED;
}

// ─── Post-hoc merge helpers ───────────────────────────────────────────────────

/**
 * Merge a verification result (from M2.1 verifier) into an existing bundle.
 * Returns a new bundle (does not mutate the original).
 *
 * @param {EvidenceBundle} bundle
 * @param {object} verResult
 * @param {boolean} verResult.passed
 * @param {string[]} verResult.commands   - commands that ran
 * @param {number}  verResult.durationMs
 * @param {string}  [verResult.failureReason]
 * @returns {EvidenceBundle}
 */
function mergeVerificationResult(bundle, verResult) {
  const newOutcome = verResult.passed ? bundle.outcome : OUTCOMES.VERIFICATION_FAILED;
  return {
    ...bundle,
    outcome: newOutcome,
    verification: {
      passed:        verResult.passed,
      commands:      verResult.commands || [],
      durationMs:    verResult.durationMs || null,
      failureReason: verResult.failureReason || null,
      ranAt:         verResult.ranAt || new Date().toISOString(),
    },
  };
}

/**
 * Merge a rescan result (from M2.2 adapter) into an existing bundle.
 * Returns a new bundle (does not mutate the original).
 *
 * @param {EvidenceBundle} bundle
 * @param {object} rescanResult
 * @param {string} rescanResult.status   - RESOLVED_AND_RESCANNED | RESOLVED_NOT_RESCANNED |
 *                                         INSTALL_VERIFIED_ONLY | VERIFICATION_FAILED
 * @param {string[]} [rescanResult.remainingCveIds]  - CVEs still open after rescan
 * @param {string}   [rescanResult.rescanReportFile]
 * @returns {EvidenceBundle}
 */
function mergeRescanResult(bundle, rescanResult) {
  // If rescan shows CVEs still open, downgrade outcome
  const hasCvesRemaining = Array.isArray(rescanResult.remainingCveIds)
    && rescanResult.remainingCveIds.length > 0;
  const newOutcome = (rescanResult.status === 'VERIFICATION_FAILED' || hasCvesRemaining)
    ? OUTCOMES.VERIFICATION_FAILED
    : bundle.outcome;

  return {
    ...bundle,
    outcome: newOutcome,
    rescan: {
      status:            rescanResult.status,
      remainingCveIds:   rescanResult.remainingCveIds   || [],
      rescanReportFile:  rescanResult.rescanReportFile  || null,
      ranAt:             rescanResult.ranAt || new Date().toISOString(),
    },
  };
}

/**
 * Merge an exposure classification (from D1A) into an existing bundle.
 * Returns a new bundle (does not mutate the original).
 *
 * @param {EvidenceBundle} bundle
 * @param {object} exposureResult
 * @param {string}   exposureResult.classification  - EXPOSURE value
 * @param {number}   exposureResult.confidence      - 0–1
 * @param {string[]} exposureResult.evidenceSources
 * @returns {EvidenceBundle}
 */
function mergeExposureClassification(bundle, exposureResult) {
  return {
    ...bundle,
    exposure: {
      classification:  exposureResult.classification,
      confidence:      exposureResult.confidence      || null,
      evidenceSources: exposureResult.evidenceSources || [],
    },
  };
}

// ─── SARIF export (M2.4) ─────────────────────────────────────────────────────
/**
 * Serialize an array of EvidenceBundles to a SARIF 2.1.0 log object.
 * Consumers write this to disk with JSON.stringify.
 *
 * @param {EvidenceBundle[]} bundles
 * @param {object} [opts]
 * @param {string} [opts.toolName]    - defaults to 'mend-autofixer'
 * @param {string} [opts.toolVersion] - defaults to '0.0.0'
 * @returns {object} SARIF log
 */
function toSarif(bundles, opts = {}) {
  const toolName    = opts.toolName    || 'mend-autofixer';
  const toolVersion = opts.toolVersion || '0.0.0';

  const results = bundles.map(b => {
    const ruleId = b.cves.length > 0 ? b.cves[0].id : `DEP-${b.libraryName}`;
    return {
      ruleId,
      message: {
        text: `${b.libraryName}@${b.currentVersion}: ${b.outcome}` +
              (b.fixVersion ? ` → ${b.fixVersion}` : ''),
      },
      level:      _sarifLevel(b),
      properties: {
        phase:          b.phase,
        outcome:        b.outcome,
        upgradeType:    b.upgradeType,
        exposure:       b.exposure.classification,
        fixVersion:     b.fixVersion,
        verificationPassed: b.verification ? b.verification.passed : null,
        rescanStatus:   b.rescan ? b.rescan.status : null,
        cves:           b.cves.map(c => c.id),
      },
    };
  });

  return {
    version: '2.1.0',
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [{
      tool: {
        driver: {
          name: toolName,
          version: toolVersion,
          informationUri: 'https://github.com/mend/mend-autofixer',
          rules: _sarifRules(bundles),
        },
      },
      results,
    }],
  };
}

function _sarifLevel(bundle) {
  const maxSev = bundle.cves.reduce((max, c) => {
    const rank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
    return (rank[c.severity] || 0) > (rank[max] || 0) ? c.severity : max;
  }, 'UNKNOWN');
  return { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'note', UNKNOWN: 'none' }[maxSev] || 'none';
}

function _sarifRules(bundles) {
  const seen = new Set();
  const rules = [];
  for (const b of bundles) {
    for (const c of b.cves) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        rules.push({
          id: c.id,
          name: c.id,
          shortDescription: { text: `Vulnerability ${c.id} in ${b.libraryName}` },
          properties: { severity: c.severity, score: c.score },
        });
      }
    }
  }
  return rules;
}

// ─── CycloneDX/VEX export (M2.4) ─────────────────────────────────────────────
/**
 * Serialize an array of EvidenceBundles to a CycloneDX 1.5 VEX document.
 *
 * @param {EvidenceBundle[]} bundles
 * @param {object} [opts]
 * @param {string} [opts.serialNumber]  - BOM serial number (UUID-style)
 * @param {string} [opts.component]     - component name for the project
 * @returns {object} CycloneDX VEX document
 */
function toCycloneDxVex(bundles, opts = {}) {
  const serialNumber = opts.serialNumber || `urn:uuid:00000000-0000-0000-0000-${Date.now()}`;
  const component    = opts.component    || 'unknown';

  const vulnerabilities = bundles.flatMap(b =>
    b.cves.map(c => ({
      id: c.id,
      ratings: [{
        severity: (c.severity || 'unknown').toLowerCase(),
        score:    c.score || undefined,
        method:   'CVSSv3',
      }],
      affects: [{
        ref: `pkg:${b.ecosystem || 'generic'}/${b.libraryName}@${b.currentVersion}`,
      }],
      analysis: {
        state:         _vexState(b.outcome),
        justification: b.humanEvidence   || undefined,
        response:      [_vexResponse(b.outcome)],
        detail:        b.humanAlternative || undefined,
      },
      properties: [
        { name: 'phase',       value: b.phase },
        { name: 'outcome',     value: b.outcome },
        { name: 'upgradeType', value: b.upgradeType },
        { name: 'exposure',    value: b.exposure.classification },
        ...(b.fixVersion ? [{ name: 'fixVersion', value: b.fixVersion }] : []),
      ],
    }))
  );

  return {
    bomFormat:   'CycloneDX',
    specVersion: '1.5',
    serialNumber,
    version:     1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: component },
      tools: [{ name: 'mend-autofixer', version: '0.0.0' }],
    },
    vulnerabilities,
  };
}

function _vexState(outcome) {
  const map = {
    FIXED:                  'resolved',
    NOT_AFFECTED:           'not_affected',
    MITIGATED:              'resolved_with_pedigree',
    PATCHED:                'resolved',
    FORKED:                 'resolved_with_pedigree',
    ACCEPTED_RISK:          'exploitable',
    LICENSE_BLOCKED:        'in_triage',
    VERIFICATION_FAILED:    'in_triage',
    REQUIRES_MIGRATION:     'in_triage',
    NO_SAFE_PATH:           'in_triage',
    LLM_SYNTHESIZED_PATCH:  'in_triage',
  };
  return map[outcome] || 'in_triage';
}

function _vexResponse(outcome) {
  const map = {
    FIXED:                  'update',
    NOT_AFFECTED:           'will_not_fix',
    MITIGATED:              'workaround_available',
    PATCHED:                'update',
    FORKED:                 'update',
    ACCEPTED_RISK:          'can_not_fix',
    LICENSE_BLOCKED:        'can_not_fix',
    VERIFICATION_FAILED:    'rollback',
    REQUIRES_MIGRATION:     'update',
    NO_SAFE_PATH:           'can_not_fix',
    LLM_SYNTHESIZED_PATCH:  'workaround_available',
  };
  return map[outcome] || 'can_not_fix';
}

// ─── D3.1 patch merge helper ─────────────────────────────────────────────────
/**
 * Merge patch metadata (from D3.1 patch-engine) into an existing bundle.
 * Returns a new bundle (does not mutate the original).
 *
 * @param {EvidenceBundle} bundle
 * @param {object} patchEvidence   result of buildPatchEvidence(patchData)
 * @returns {EvidenceBundle}
 */
function mergePatchData(bundle, patchEvidence) {
  return { ...bundle, patch: patchEvidence };
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  SCHEMA_VERSION,
  OUTCOMES,
  EXPOSURE,
  createEvidence,
  mergeVerificationResult,
  mergeRescanResult,
  mergeExposureClassification,
  mergePatchData,
  toSarif,
  toCycloneDxVex,
};
