'use strict';

const { resolveFixVersion, buildResolutionPlan } = require('../../src/core/semver-engine');

describe('resolveFixVersion', () => {
  test('same-major safe upgrade', () => {
    const result = resolveFixVersion({
      currentVersion: '6.4.0',
      cves: [{ id: 'CVE-001', fixVersions: ['6.5.7', '7.0.0'] }],
    });
    expect(result.upgradeType).toBe('SAFE');
    expect(result.recommendedVersion).toBe('6.5.7');
  });

  test('cross-major bump when no same-major fix exists', () => {
    const result = resolveFixVersion({
      currentVersion: '4.1.0',
      cves: [{ id: 'CVE-002', fixVersions: ['5.0.0'] }],
    });
    expect(result.upgradeType).toBe('MAJOR_BUMP');
    expect(result.recommendedVersion).toBe('5.0.0');
  });

  test('no fix available returns NO_FIX', () => {
    const result = resolveFixVersion({
      currentVersion: '1.0.0',
      cves: [{ id: 'CVE-003', fixVersions: [] }],
    });
    expect(result.upgradeType).toBe('NO_FIX');
    expect(result.recommendedVersion).toBeNull();
  });

  test('multiple CVEs — picks version that covers all', () => {
    const result = resolveFixVersion({
      currentVersion: '6.0.0',
      cves: [
        { id: 'CVE-A', fixVersions: ['6.5.0'] },
        { id: 'CVE-B', fixVersions: ['6.6.0'] },
      ],
    });
    expect(result.upgradeType).toBe('SAFE');
    expect(result.recommendedVersion).toBe('6.6.0');
  });

  test('empty fixVersions on one CVE when another has a fix — returns MAJOR_BUMP (cannot cover all CVEs)', () => {
    // CVE-Y has no fix; the engine cannot find a version covering both CVEs → fallback MAJOR_BUMP
    const result = resolveFixVersion({
      currentVersion: '2.0.0',
      cves: [
        { id: 'CVE-X', fixVersions: ['2.1.0'] },
        { id: 'CVE-Y', fixVersions: [] },
      ],
    });
    expect(result.upgradeType).toBe('MAJOR_BUMP');
  });

  test('ALL CVEs have empty fixVersions → NO_FIX', () => {
    const result = resolveFixVersion({
      currentVersion: '2.0.0',
      cves: [
        { id: 'CVE-X', fixVersions: [] },
        { id: 'CVE-Y', fixVersions: [] },
      ],
    });
    expect(result.upgradeType).toBe('NO_FIX');
  });

  test('invalid currentVersion returns NO_FIX', () => {
    const result = resolveFixVersion({
      currentVersion: 'not-a-semver',
      cves: [{ id: 'CVE-001', fixVersions: ['1.2.3'] }],
    });
    expect(result.upgradeType).toBe('NO_FIX');
  });

  test('empty cves array returns NO_FIX', () => {
    const result = resolveFixVersion({ currentVersion: '1.0.0', cves: [] });
    expect(result.upgradeType).toBe('NO_FIX');
  });
});

describe('buildResolutionPlan', () => {
  test('empty CVE array does not crash (highestCvssScore is 0)', () => {
    const plan = buildResolutionPlan([{
      libraryName: 'test-pkg',
      currentVersion: '1.0.0',
      cves: [],
    }]);
    expect(plan[0].highestCvssScore).toBe(0);
  });
});
