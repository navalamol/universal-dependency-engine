'use strict';

// M2.3 — Fail-closed evidence gate.
// Called after Phase A application to decide whether each item may proceed.
// When required evidence is missing or failed, the item is blocked or its
// phase is downgraded from A → B so it is not auto-committed.
//
// Policy fields (all optional, default false/null):
//   requireVerification  {boolean}  — Phase A is blocked unless verification passed
//   requireRescan        {boolean}  — Phase A is blocked unless rescan ran and passed
//   allowedPhases        {string[]} — limit which phases may proceed (default: all)

const { OUTCOMES } = require('./evidence-model');

// Gate decisions
const GATE_DECISION = Object.freeze({
  ALLOWED:    'ALLOWED',     // evidence complete and passed — proceed
  DOWNGRADED: 'DOWNGRADED',  // evidence incomplete — A→B (human review before commit)
  BLOCKED:    'BLOCKED',     // evidence present but failed — do not apply
});

/**
 * Evaluate the gate for a single EvidenceBundle against a policy.
 *
 * @param {object} bundle   - EvidenceBundle from evidence-model.js
 * @param {object} [policy]
 * @param {boolean} [policy.requireVerification=false]
 * @param {boolean} [policy.requireRescan=false]
 * @returns {{ decision: string, reasons: string[] }}
 */
function evaluateBundleGate(bundle, policy = {}) {
  const requireVerification = policy.requireVerification || false;
  const requireRescan       = policy.requireRescan       || false;

  const reasons = [];

  // Hard block: verification ran and failed — block regardless of policy
  if (bundle.verification !== null && !bundle.verification.passed) {
    return {
      decision: GATE_DECISION.BLOCKED,
      reasons: [`Verification failed: ${bundle.verification.failureReason || 'unknown reason'}`],
    };
  }

  // Hard block: rescan ran and still shows open CVEs — block regardless of policy
  if (bundle.rescan !== null && bundle.rescan.status === 'VERIFICATION_FAILED') {
    const ids = (bundle.rescan.remainingCveIds || []).join(', ') || 'unknown';
    return {
      decision: GATE_DECISION.BLOCKED,
      reasons:  [`Rescan failed — CVEs still present: ${ids}`],
    };
  }

  // Evidence incomplete: check required-but-not-run cases → downgrade
  if (requireVerification && bundle.verification === null) {
    reasons.push('Verification required but not run');
  }
  if (requireRescan && bundle.rescan === null) {
    reasons.push('Rescan required but not run');
  }

  if (reasons.length > 0) {
    // Evidence incomplete → downgrade (human review) rather than hard block
    return { decision: GATE_DECISION.DOWNGRADED, reasons };
  }

  return { decision: GATE_DECISION.ALLOWED, reasons: [] };
}

/**
 * Apply the gate to a full list of EvidenceBundles + their corresponding PhasedItems.
 * Phase A items that are DOWNGRADED have their phase mutated to 'B'.
 * BLOCKED items are flagged with `gateBlocked: true` and a `gateReason` field.
 * Items of Phase B/C or non-FIXED outcomes are passed through as ALLOWED.
 *
 * Returns a new array of PhasedItems with gate annotations applied (no mutation
 * of the original; bundles are updated via merging in the evidence model).
 *
 * @param {object[]} phasedPlan   - PhasedItem[]
 * @param {object[]} bundles      - parallel EvidenceBundle[] (same order as phasedPlan)
 * @param {object}   [policy]
 * @returns {{ phasedPlan: object[], gateReport: object[] }}
 */
function applyEvidenceGate(phasedPlan, bundles, policy = {}) {
  if (phasedPlan.length !== bundles.length) {
    throw new Error('applyEvidenceGate: phasedPlan and bundles must be the same length');
  }

  const updatedPlan = [];
  const gateReport  = [];

  for (let i = 0; i < phasedPlan.length; i++) {
    const item   = phasedPlan[i];
    const bundle = bundles[i];

    // Gate only applies to Phase A items with a FIXED/initial outcome
    const gateApplies = item.phase === 'A';

    if (!gateApplies) {
      updatedPlan.push({ ...item });
      gateReport.push({ libraryName: item.libraryName, phase: item.phase, decision: GATE_DECISION.ALLOWED, reasons: [] });
      continue;
    }

    const { decision, reasons } = evaluateBundleGate(bundle, policy);

    const updatedItem = { ...item };

    if (decision === GATE_DECISION.DOWNGRADED) {
      updatedItem.phase         = 'B';
      updatedItem.justification = (item.justification || '') +
        ` [Downgraded A→B by evidence gate: ${reasons.join('; ')}]`;
    } else if (decision === GATE_DECISION.BLOCKED) {
      updatedItem.gateBlocked = true;
      updatedItem.gateReason  = reasons.join('; ');
    }

    updatedPlan.push(updatedItem);
    gateReport.push({ libraryName: item.libraryName, phase: item.phase, decision, reasons });
  }

  return { phasedPlan: updatedPlan, gateReport };
}

module.exports = {
  GATE_DECISION,
  evaluateBundleGate,
  applyEvidenceGate,
};
