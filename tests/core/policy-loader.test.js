'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const {
  parsePolicy,
  loadPolicy,
  isFreezeWindow,
  isDenylisted,
  meetsSeverityThreshold,
  isPhaseAllowed,
  toGatePolicy,
  DEFAULT_POLICY,
} = require('../../src/core/policy-loader');

// ─── parsePolicy — defaults ───────────────────────────────────────────────────

test('parsePolicy with empty object returns all defaults', () => {
  const { policy, verification, rescan, errors } = parsePolicy({});
  expect(policy.allowedPhases).toEqual(['A']);
  expect(policy.severityThreshold).toBe('MEDIUM');
  expect(policy.blastRadiusLimit).toBeNull();
  expect(policy.packageDenylist).toEqual([]);
  expect(policy.freezeWindows).toEqual([]);
  expect(verification.requireVerification).toBe(false);
  expect(verification.requireRescan).toBe(false);
  expect(rescan.enabled).toBe(false);
  expect(errors).toEqual([]);
});

test('parsePolicy with null returns defaults', () => {
  const { policy } = parsePolicy(null);
  expect(policy.allowedPhases).toEqual(['A']);
});

// ─── version validation ───────────────────────────────────────────────────────

test('parsePolicy version=1 is accepted', () => {
  const { errors } = parsePolicy({ version: 1 });
  expect(errors).toEqual([]);
});

test('parsePolicy unknown version adds an error', () => {
  const { errors } = parsePolicy({ version: 2 });
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]).toContain('version');
});

// ─── policy block ─────────────────────────────────────────────────────────────

test('parsePolicy allowedPhases: ["A","B"]', () => {
  const { policy } = parsePolicy({ version: 1, policy: { allowedPhases: ['A', 'B'] } });
  expect(policy.allowedPhases).toEqual(['A', 'B']);
});

test('parsePolicy allowedPhases: ["C"] is valid', () => {
  const { policy } = parsePolicy({ policy: { allowedPhases: ['C'] } });
  expect(policy.allowedPhases).toEqual(['C']);
});

test('parsePolicy invalid phase values are filtered with error', () => {
  const { policy, errors } = parsePolicy({ policy: { allowedPhases: ['A', 'X'] } });
  expect(policy.allowedPhases).toEqual(['A']);
  expect(errors.length).toBeGreaterThan(0);
});

test('parsePolicy severityThreshold HIGH', () => {
  const { policy } = parsePolicy({ policy: { severityThreshold: 'HIGH' } });
  expect(policy.severityThreshold).toBe('HIGH');
});

test('parsePolicy invalid severityThreshold adds error, keeps default', () => {
  const { policy, errors } = parsePolicy({ policy: { severityThreshold: 'MODERATE' } });
  expect(policy.severityThreshold).toBe('MEDIUM'); // falls back to default
  expect(errors.length).toBeGreaterThan(0);
});

test('parsePolicy packageDenylist is set', () => {
  const { policy } = parsePolicy({ policy: { packageDenylist: ['lodash', 'request'] } });
  expect(policy.packageDenylist).toEqual(['lodash', 'request']);
});

test('parsePolicy blastRadiusLimit integer', () => {
  const { policy } = parsePolicy({ policy: { blastRadiusLimit: 10 } });
  expect(policy.blastRadiusLimit).toBe(10);
});

test('parsePolicy freezeWindows parsed correctly', () => {
  const raw = {
    policy: {
      freezeWindows: [
        { start: '2025-12-20', end: '2026-01-05', reason: 'Year-end freeze' },
      ],
    },
  };
  const { policy } = parsePolicy(raw);
  expect(policy.freezeWindows).toHaveLength(1);
  expect(policy.freezeWindows[0].start).toBe('2025-12-20');
  expect(policy.freezeWindows[0].reason).toBe('Year-end freeze');
});

test('parsePolicy freeze windows with missing start/end are filtered out', () => {
  const { policy } = parsePolicy({ policy: { freezeWindows: [{ start: '2025-12-20' }] } });
  expect(policy.freezeWindows).toHaveLength(0);
});

// ─── verification block ───────────────────────────────────────────────────────

test('parsePolicy verification requireVerification=true', () => {
  const { verification } = parsePolicy({ verification: { requireVerification: true } });
  expect(verification.requireVerification).toBe(true);
});

test('parsePolicy verification build commands parsed', () => {
  const raw = { verification: { build: [{ cmd: 'npm', args: ['run', 'build'], required: true }] } };
  const { verification } = parsePolicy(raw);
  expect(verification.build).toHaveLength(1);
  expect(verification.build[0].cmd).toBe('npm');
});

// ─── rescan block ─────────────────────────────────────────────────────────────

test('parsePolicy rescan enabled=true with provider', () => {
  const { rescan } = parsePolicy({ rescan: { enabled: true, provider: 'trivy' } });
  expect(rescan.enabled).toBe(true);
  expect(rescan.provider).toBe('trivy');
});

// ─── isFreezeWindow ───────────────────────────────────────────────────────────

test('isFreezeWindow returns false with no freeze windows', () => {
  const loaded = parsePolicy({});
  expect(isFreezeWindow(loaded, new Date('2026-08-21'))).toBe(false);
});

test('isFreezeWindow returns true when today is in window', () => {
  const loaded = parsePolicy({
    policy: { freezeWindows: [{ start: '2026-08-01', end: '2026-08-31' }] },
  });
  expect(isFreezeWindow(loaded, new Date('2026-08-21'))).toBe(true);
});

test('isFreezeWindow returns false when today is outside window', () => {
  const loaded = parsePolicy({
    policy: { freezeWindows: [{ start: '2026-08-01', end: '2026-08-10' }] },
  });
  expect(isFreezeWindow(loaded, new Date('2026-08-21'))).toBe(false);
});

test('isFreezeWindow start and end dates are inclusive', () => {
  const loaded = parsePolicy({
    policy: { freezeWindows: [{ start: '2026-08-21', end: '2026-08-21' }] },
  });
  expect(isFreezeWindow(loaded, new Date('2026-08-21'))).toBe(true);
});

// ─── isDenylisted ─────────────────────────────────────────────────────────────

test('isDenylisted returns true for listed package', () => {
  const loaded = parsePolicy({ policy: { packageDenylist: ['lodash'] } });
  expect(isDenylisted(loaded, 'lodash')).toBe(true);
});

test('isDenylisted returns false for unlisted package', () => {
  const loaded = parsePolicy({ policy: { packageDenylist: ['lodash'] } });
  expect(isDenylisted(loaded, 'axios')).toBe(false);
});

test('isDenylisted returns false with empty denylist', () => {
  const loaded = parsePolicy({});
  expect(isDenylisted(loaded, 'anything')).toBe(false);
});

// ─── meetsSeverityThreshold ───────────────────────────────────────────────────

test('meetsSeverityThreshold CRITICAL meets HIGH threshold', () => {
  const loaded = parsePolicy({ policy: { severityThreshold: 'HIGH' } });
  expect(meetsSeverityThreshold(loaded, 'CRITICAL')).toBe(true);
});

test('meetsSeverityThreshold MEDIUM does not meet HIGH threshold', () => {
  const loaded = parsePolicy({ policy: { severityThreshold: 'HIGH' } });
  expect(meetsSeverityThreshold(loaded, 'MEDIUM')).toBe(false);
});

test('meetsSeverityThreshold LOW does not meet MEDIUM threshold (default)', () => {
  const loaded = parsePolicy({});
  expect(meetsSeverityThreshold(loaded, 'LOW')).toBe(false);
});

test('meetsSeverityThreshold MEDIUM meets MEDIUM threshold', () => {
  const loaded = parsePolicy({});
  expect(meetsSeverityThreshold(loaded, 'MEDIUM')).toBe(true);
});

// ─── isPhaseAllowed ───────────────────────────────────────────────────────────

test('isPhaseAllowed A is allowed with default policy', () => {
  const loaded = parsePolicy({});
  expect(isPhaseAllowed(loaded, 'A')).toBe(true);
});

test('isPhaseAllowed B is not allowed with default policy', () => {
  const loaded = parsePolicy({});
  expect(isPhaseAllowed(loaded, 'B')).toBe(false);
});

test('isPhaseAllowed with allowedPhases: ["A","B"]', () => {
  const loaded = parsePolicy({ policy: { allowedPhases: ['A', 'B'] } });
  expect(isPhaseAllowed(loaded, 'B')).toBe(true);
  expect(isPhaseAllowed(loaded, 'C')).toBe(false);
});

// ─── toGatePolicy ─────────────────────────────────────────────────────────────

test('toGatePolicy with defaults returns requireVerification=false', () => {
  const loaded = parsePolicy({});
  expect(toGatePolicy(loaded)).toEqual({ requireVerification: false, requireRescan: false });
});

test('toGatePolicy with requireVerification=true', () => {
  const loaded = parsePolicy({ verification: { requireVerification: true, requireRescan: true } });
  expect(toGatePolicy(loaded)).toEqual({ requireVerification: true, requireRescan: true });
});

// ─── loadPolicy — filesystem round-trip ──────────────────────────────────────

test('loadPolicy returns defaults when no policy file exists', () => {
  const dir    = os.tmpdir();
  const result = loadPolicy(dir);
  expect(result.filePath).toBeNull();
  expect(result.policy.allowedPhases).toEqual(['A']);
});

test('loadPolicy reads a real .dependency-intelligence.yml file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-intel-test-'));
  const yaml   = `version: 1\npolicy:\n  allowedPhases:\n    - A\n    - B\n  severityThreshold: HIGH\n`;
  fs.writeFileSync(path.join(tmpDir, '.dependency-intelligence.yml'), yaml, 'utf8');

  const result = loadPolicy(tmpDir);
  expect(result.filePath).not.toBeNull();
  expect(result.policy.allowedPhases).toEqual(['A', 'B']);
  expect(result.policy.severityThreshold).toBe('HIGH');

  // Cleanup
  fs.unlinkSync(path.join(tmpDir, '.dependency-intelligence.yml'));
  fs.rmdirSync(tmpDir);
});
