'use strict';

const { applyPhases } = require('../../src/core/phases');

function makeResItem(overrides) {
  return {
    libraryName: 'test-pkg',
    currentVersion: '1.0.0',
    recommendedVersion: '1.2.0',
    upgradeType: 'SAFE',
    cves: [{ id: 'CVE-001', fixVersions: ['1.2.0'] }],
    ...overrides,
  };
}

function makeDepTree(entries) {
  const m = new Map();
  for (const [name, arr] of Object.entries(entries)) {
    m.set(name, arr);
  }
  return m;
}

describe('applyPhases — phase classification', () => {
  test('single safe-range item → Phase A', () => {
    const plan = [makeResItem()];
    const [item] = applyPhases(plan, null);
    expect(item.phase).toBe('A');
  });

  test('MAJOR_BUMP item → Phase C always', () => {
    const plan = [makeResItem({ upgradeType: 'MAJOR_BUMP', recommendedVersion: '2.0.0' })];
    const [item] = applyPhases(plan, null);
    expect(item.phase).toBe('C');
  });

  test('NO_FIX item → Phase C', () => {
    const plan = [makeResItem({ upgradeType: 'NO_FIX', recommendedVersion: null })];
    const [item] = applyPhases(plan, null);
    expect(item.phase).toBe('C');
  });

  test('Phase A → Phase B downgrade when consumer range is violated', () => {
    const depTree = makeDepTree({
      'test-pkg': [
        {
          resolvedVersion: '1.0.0',
          dev: false,
          parents: [{ name: 'parent-x', range: '~1.0.0' }],
        },
      ],
    });
    const plan = [makeResItem({ recommendedVersion: '1.2.0' })];
    const [item] = applyPhases(plan, depTree);
    // ~1.0.0 does not satisfy 1.2.0, should downgrade to Phase B
    expect(item.phase).toBe('B');
    expect(item.rangeViolation).toBeTruthy();
    expect(item.rangeViolation.consumer).toBe('parent-x');
  });

  test('all lock-file entries dev:true → probableFalsePositive for NO_FIX', () => {
    const depTree = makeDepTree({
      'no-fix-pkg': [
        { resolvedVersion: '1.0.0', dev: true, parents: ['dev-dep'] },
      ],
    });
    const plan = [makeResItem({
      libraryName: 'no-fix-pkg',
      upgradeType: 'NO_FIX',
      recommendedVersion: null,
    })];
    const [item] = applyPhases(plan, depTree);
    expect(item.probableFalsePositive).toBe(true);
  });

  test('mixed dev/prod entries → probableFalsePositive NOT set', () => {
    const depTree = makeDepTree({
      'mixed-pkg': [
        { resolvedVersion: '1.0.0', dev: true,  parents: ['dev-dep'] },
        { resolvedVersion: '1.0.0', dev: false, parents: ['prod-dep'] },
      ],
    });
    const plan = [makeResItem({
      libraryName: 'mixed-pkg',
      upgradeType: 'NO_FIX',
      recommendedVersion: null,
    })];
    const [item] = applyPhases(plan, depTree);
    expect(item.probableFalsePositive).toBeFalsy();
  });
});
