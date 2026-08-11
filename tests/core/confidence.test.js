'use strict';

const { enrichWithConfidence } = require('../../src/core/confidence');

describe('enrichWithConfidence — range-violation items', () => {
  test('evidence contains consumer name (not undefined) for Phase B range-violation', () => {
    const phasedPlan = [{
      libraryName: 'test-pkg',
      currentVersion: '1.0.0',
      recommendedVersion: '1.2.0',
      upgradeType: 'SAFE',
      phase: 'B',
      rangeViolation: { consumer: 'react', range: '~1.0.0' },
      cves: [],
    }];
    const [item] = enrichWithConfidence(phasedPlan, null);
    expect(item.evidence).toContain('Consumer `react`');
    expect(item.evidence).not.toContain('undefined');
    expect(item.alternative).toContain('react');
    expect(item.alternative).not.toContain('undefined');
  });

  test('Phase A item evidence does not contain rangeViolation text', () => {
    const phasedPlan = [{
      libraryName: 'safe-pkg',
      currentVersion: '2.0.0',
      recommendedVersion: '2.1.0',
      upgradeType: 'SAFE',
      phase: 'A',
      cves: [],
    }];
    const [item] = enrichWithConfidence(phasedPlan, null);
    expect(item.evidence).toContain('Same-major upgrade');
    expect(item.evidence).not.toContain('undefined');
  });
});
