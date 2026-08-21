'use strict';

const {
  LLM_PATCH_OUTCOME,
  APPROVAL_STATE,
  isEnabled,
  suggestPatch,
  applyApproval,
} = require('../../src/core/llm-patch-advisor');

function makeItem(overrides = {}) {
  return {
    libraryName:        'lodash',
    currentVersion:     '4.17.15',
    recommendedVersion: '4.17.21',
    phase:              'C',
    cves:               [{ id: 'CVE-2021-23337' }],
    ...overrides,
  };
}

// ─── isEnabled ────────────────────────────────────────────────────────────────
describe('isEnabled', () => {
  test('disabled by default (no opts)', () => {
    expect(isEnabled()).toBe(false);
  });

  test('disabled when flag is false', () => {
    expect(isEnabled({ llmPatchAdvisorEnabled: false })).toBe(false);
  });

  test('enabled when flag is true', () => {
    expect(isEnabled({ llmPatchAdvisorEnabled: true })).toBe(true);
  });
});

// ─── suggestPatch ─────────────────────────────────────────────────────────────
describe('suggestPatch', () => {
  test('returns null when feature-flag is off', () => {
    expect(suggestPatch(makeItem(), {}, {})).toBeNull();
  });

  test('returns null when feature-flag is off even with valid item', () => {
    expect(suggestPatch(makeItem())).toBeNull();
  });

  test('throws if item.libraryName is missing when flag is on', () => {
    expect(() => suggestPatch({}, {}, { llmPatchAdvisorEnabled: true }))
      .toThrow('item.libraryName required');
  });

  test('returns suggestion with requiresHumanApproval: true', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s).not.toBeNull();
    expect(s.requiresHumanApproval).toBe(true);
  });

  test('autoPublish is always false', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s.autoPublish).toBe(false);
  });

  test('affectsPhaseClassification is always false', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s.affectsPhaseClassification).toBe(false);
  });

  test('outcome is LLM_SYNTHESIZED_PATCH', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s.outcome).toBe(LLM_PATCH_OUTCOME);
    expect(s.outcome).toBe('LLM_SYNTHESIZED_PATCH');
  });

  test('approvalState starts as PENDING', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s.approvalState).toBe(APPROVAL_STATE.PENDING);
  });

  test('captures patchContext fields', () => {
    const context = { diff: '--- a\n+++ b\n', rationale: 'fixes XSS', llmModel: 'claude-3', promptHash: 'abc123' };
    const s = suggestPatch(makeItem(), context, { llmPatchAdvisorEnabled: true });
    expect(s.diff).toBe(context.diff);
    expect(s.rationale).toBe(context.rationale);
    expect(s.llmModel).toBe(context.llmModel);
    expect(s.promptHash).toBe(context.promptHash);
  });

  test('includes pkgName, installedVersion, targetVersion', () => {
    const s = suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
    expect(s.pkgName).toBe('lodash');
    expect(s.installedVersion).toBe('4.17.15');
    expect(s.targetVersion).toBe('4.17.21');
  });
});

// ─── applyApproval ────────────────────────────────────────────────────────────
describe('applyApproval', () => {
  function makeSuggestion() {
    return suggestPatch(makeItem(), {}, { llmPatchAdvisorEnabled: true });
  }

  test('sets approvalState to APPROVED', () => {
    const s = makeSuggestion();
    const updated = applyApproval(s, APPROVAL_STATE.APPROVED);
    expect(updated.approvalState).toBe(APPROVAL_STATE.APPROVED);
  });

  test('sets approvalState to REJECTED', () => {
    const s = makeSuggestion();
    const updated = applyApproval(s, APPROVAL_STATE.REJECTED);
    expect(updated.approvalState).toBe(APPROVAL_STATE.REJECTED);
  });

  test('does not mutate original suggestion', () => {
    const s = makeSuggestion();
    applyApproval(s, APPROVAL_STATE.APPROVED);
    expect(s.approvalState).toBe(APPROVAL_STATE.PENDING);
  });

  test('records approvedBy and approvedAt', () => {
    const s = makeSuggestion();
    const updated = applyApproval(s, APPROVAL_STATE.APPROVED, {
      approvedBy: 'security-team',
      approvedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(updated.approvedBy).toBe('security-team');
    expect(updated.approvedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  test('throws on invalid decision string', () => {
    const s = makeSuggestion();
    expect(() => applyApproval(s, 'MAYBE')).toThrow(/Invalid decision/);
  });
});
