'use strict';

const { computeSecurityDelta } = require('../../src/core/security-delta');

function makeFindings(items) {
  return items.map(({ name, current, fix, severity = 'HIGH' }) => ({
    libraryName: name,
    currentVersion: current,
    cves: [{ id: 'CVE-TEST-001', severity, score: 8.0, fixVersions: [fix] }],
  }));
}

describe('computeSecurityDelta', () => {
  test('returns empty arrays for empty inputs', () => {
    expect(computeSecurityDelta(new Map(), [])).toEqual({ introduced: [], fixed: [] });
    expect(computeSecurityDelta(null, null)).toEqual({ introduced: [], fixed: [] });
  });

  test('marks a package as fixed when simulation resolves >= fixVersion', () => {
    const resolved = new Map([['lodash', '4.17.21']]);
    const findings = makeFindings([{ name: 'lodash', current: '4.17.15', fix: '4.17.21' }]);
    const { fixed, introduced } = computeSecurityDelta(resolved, findings);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].name).toBe('lodash');
    expect(introduced).toHaveLength(0);
  });

  test('marks a package as introduced when simulation regresses a previously-safe version', () => {
    // Current version is already safe (>= fix), but simulation picks an older version
    const resolved = new Map([['express', '4.16.0']]);
    const findings = makeFindings([{ name: 'express', current: '4.18.2', fix: '4.17.0' }]);
    const { introduced, fixed } = computeSecurityDelta(resolved, findings);
    expect(introduced).toHaveLength(1);
    expect(introduced[0].name).toBe('express');
    expect(fixed).toHaveLength(0);
  });

  test('ignores packages not in resolvedVersions', () => {
    const resolved = new Map([['axios', '1.7.0']]);
    const findings = makeFindings([{ name: 'lodash', current: '4.17.15', fix: '4.17.21' }]);
    const { introduced, fixed } = computeSecurityDelta(resolved, findings);
    expect(introduced).toHaveLength(0);
    expect(fixed).toHaveLength(0);
  });

  test('handles multiple findings, only reports delta entries', () => {
    const resolved = new Map([
      ['pkgA', '2.0.0'],   // fixed (was 1.x, fix is 2.0.0)
      ['pkgB', '3.0.0'],   // still vulnerable (was 3.1.0 safe, simulation regressed)
      ['pkgC', '1.0.0'],   // not fixed (still < fix) but was already vulnerable — neither fixed nor introduced
    ]);
    const findings = makeFindings([
      { name: 'pkgA', current: '1.5.0', fix: '2.0.0' },   // was vulnerable, now fixed
      { name: 'pkgB', current: '3.2.0', fix: '3.1.0' },   // was safe, simulation regressed
      { name: 'pkgC', current: '0.9.0', fix: '1.5.0' },   // was vulnerable, still vulnerable (no change)
    ]);
    const { fixed, introduced } = computeSecurityDelta(resolved, findings);
    expect(fixed.map(f => f.name)).toEqual(['pkgA']);
    expect(introduced.map(i => i.name)).toEqual(['pkgB']);
  });
});
