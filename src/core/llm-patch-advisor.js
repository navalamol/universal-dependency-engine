'use strict';

// D3.4 — LLM-assisted candidate patches.
//
// DESIGN CONSTRAINTS (non-negotiable):
//   - Feature-flag DISABLED by default. Must be explicitly opted in.
//   - Has NO effect on Phase A/B/C classification — affectsPhaseClassification: false always.
//   - Human security approval is always required (requiresHumanApproval: true always).
//   - autoPublish: false always.
//   - This module does NOT call any LLM. It produces a structured suggestion skeleton
//     that an authorised integration layer fills in with actual LLM output.
//     This design preserves engine determinism and keeps the approval gate non-bypassable.

const LLM_PATCH_OUTCOME = 'LLM_SYNTHESIZED_PATCH';

const APPROVAL_STATE = Object.freeze({
  PENDING:  'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

/**
 * Check whether the LLM patch advisor is enabled.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.llmPatchAdvisorEnabled=false]
 * @returns {boolean}
 */
function isEnabled(opts = {}) {
  return opts.llmPatchAdvisorEnabled === true;
}

/**
 * Build an LLM patch suggestion skeleton for a PhasedItem.
 * Returns null when the feature-flag is off.
 *
 * @param {object} item           PhasedItem
 * @param {object} [patchContext] { diff?, rationale?, llmModel?, promptHash? }
 * @param {object} [opts]
 * @param {boolean} [opts.llmPatchAdvisorEnabled=false]
 * @returns {LLMPatchSuggestion|null}
 */
function suggestPatch(item, patchContext = {}, opts = {}) {
  if (!isEnabled(opts)) return null;
  if (!item || !item.libraryName) throw new Error('item.libraryName required');

  const { diff = null, rationale = null, llmModel = null, promptHash = null } = patchContext;

  return {
    pkgName:                    item.libraryName,
    installedVersion:           item.currentVersion,
    targetVersion:              item.recommendedVersion || null,
    outcome:                    LLM_PATCH_OUTCOME,
    diff,
    rationale,
    llmModel,
    promptHash,
    requiresHumanApproval:      true,
    approvalState:              APPROVAL_STATE.PENDING,
    autoPublish:                false,
    affectsPhaseClassification: false,
    generatedAt:                new Date().toISOString(),
  };
}

/**
 * Apply a human approval decision to a suggestion (immutable update).
 *
 * @param {LLMPatchSuggestion} suggestion
 * @param {'APPROVED'|'REJECTED'} decision
 * @param {object} [opts]
 * @param {string} [opts.approvedBy]
 * @param {string} [opts.approvedAt]
 * @returns {LLMPatchSuggestion}
 */
function applyApproval(suggestion, decision, opts = {}) {
  if (!Object.values(APPROVAL_STATE).includes(decision)) {
    throw new Error(`Invalid decision "${decision}". Use APPROVED or REJECTED.`);
  }
  return {
    ...suggestion,
    approvalState: decision,
    approvedBy:    opts.approvedBy || null,
    approvedAt:    opts.approvedAt || new Date().toISOString(),
  };
}

module.exports = {
  LLM_PATCH_OUTCOME,
  APPROVAL_STATE,
  isEnabled,
  suggestPatch,
  applyApproval,
};
