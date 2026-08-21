'use strict';

const {
  LICENSE_DECISION,
  extractLicense,
  checkLicenseCompatibility,
  evaluateLicenseGate,
} = require('../../src/core/license-gate');

function makeItem(overrides = {}) {
  return {
    libraryName:    'lodash',
    currentVersion: '4.17.15',
    ...overrides,
  };
}

// ─── extractLicense ───────────────────────────────────────────────────────────
describe('extractLicense', () => {
  test('returns string license directly', () => {
    expect(extractLicense({ license: 'MIT' })).toBe('MIT');
  });

  test('returns license.type when license is object', () => {
    expect(extractLicense({ license: { type: 'Apache-2.0' } })).toBe('Apache-2.0');
  });

  test('returns null for null manifest', () => {
    expect(extractLicense(null)).toBeNull();
  });

  test('returns null for undefined manifest', () => {
    expect(extractLicense(undefined)).toBeNull();
  });

  test('returns null when license field absent', () => {
    expect(extractLicense({ name: 'pkg' })).toBeNull();
  });

  test('trims whitespace from string license', () => {
    expect(extractLicense({ license: '  MIT  ' })).toBe('MIT');
  });

  test('returns null for empty string license', () => {
    expect(extractLicense({ license: '' })).toBeNull();
  });
});

// ─── checkLicenseCompatibility ────────────────────────────────────────────────
describe('checkLicenseCompatibility', () => {
  test('MIT is ALLOWED', () => {
    expect(checkLicenseCompatibility('MIT').decision).toBe(LICENSE_DECISION.ALLOWED);
  });

  test('Apache-2.0 is ALLOWED', () => {
    expect(checkLicenseCompatibility('Apache-2.0').decision).toBe(LICENSE_DECISION.ALLOWED);
  });

  test('BSD-3-Clause is ALLOWED', () => {
    expect(checkLicenseCompatibility('BSD-3-Clause').decision).toBe(LICENSE_DECISION.ALLOWED);
  });

  test('GPL-3.0 is REVIEW (blockCopyleft default)', () => {
    const r = checkLicenseCompatibility('GPL-3.0');
    expect(r.decision).toBe(LICENSE_DECISION.REVIEW);
    expect(r.reason).toMatch(/copyleft/i);
  });

  test('AGPL-3.0-only is REVIEW when blockCopyleft is true', () => {
    expect(checkLicenseCompatibility('AGPL-3.0-only').decision).toBe(LICENSE_DECISION.REVIEW);
  });

  test('copyleft is ALLOWED when blockCopyleft is false', () => {
    const r = checkLicenseCompatibility('GPL-3.0', { blockCopyleft: false });
    expect(r.decision).toBe(LICENSE_DECISION.ALLOWED);
  });

  test('null license is UNKNOWN', () => {
    expect(checkLicenseCompatibility(null).decision).toBe(LICENSE_DECISION.UNKNOWN);
  });

  test('blockedLicenses policy overrides permissive', () => {
    const r = checkLicenseCompatibility('MIT', { blockedLicenses: ['MIT'] });
    expect(r.decision).toBe(LICENSE_DECISION.BLOCKED);
    expect(r.reason).toMatch(/blocked list/);
  });

  test('allowedLicenses policy allows copyleft', () => {
    const r = checkLicenseCompatibility('GPL-3.0', { allowedLicenses: ['GPL-3.0'] });
    expect(r.decision).toBe(LICENSE_DECISION.ALLOWED);
  });

  test('unknown license gets REVIEW', () => {
    const r = checkLicenseCompatibility('PROPRIETARY-1.0');
    expect(r.decision).toBe(LICENSE_DECISION.REVIEW);
  });

  test('strips parentheses from expression before matching', () => {
    const r = checkLicenseCompatibility('(MIT AND ISC)');
    expect(r.decision).toBe(LICENSE_DECISION.ALLOWED);
  });
});

// ─── evaluateLicenseGate ──────────────────────────────────────────────────────
describe('evaluateLicenseGate', () => {
  test('ALLOWED for MIT manifest', () => {
    const r = evaluateLicenseGate(makeItem(), { manifest: { license: 'MIT' } });
    expect(r.decision).toBe(LICENSE_DECISION.ALLOWED);
    expect(r.outcome).toBeNull();
    expect(r.manifestProvided).toBe(true);
  });

  test('outcome is LICENSE_BLOCKED when BLOCKED', () => {
    const r = evaluateLicenseGate(makeItem(), {
      manifest: { license: 'MIT' },
      policy:   { blockedLicenses: ['MIT'] },
    });
    expect(r.decision).toBe(LICENSE_DECISION.BLOCKED);
    expect(r.outcome).toBe('LICENSE_BLOCKED');
  });

  test('UNKNOWN when no manifest provided', () => {
    const r = evaluateLicenseGate(makeItem(), {});
    expect(r.decision).toBe(LICENSE_DECISION.UNKNOWN);
    expect(r.manifestProvided).toBe(false);
  });

  test('returns pkgName and version', () => {
    const r = evaluateLicenseGate(makeItem(), { manifest: { license: 'ISC' } });
    expect(r.pkgName).toBe('lodash');
    expect(r.version).toBe('4.17.15');
  });

  test('REVIEW for copyleft without manifest policy override', () => {
    const r = evaluateLicenseGate(makeItem(), { manifest: { license: 'GPL-3.0' } });
    expect(r.decision).toBe(LICENSE_DECISION.REVIEW);
    expect(r.outcome).toBeNull();
  });
});
