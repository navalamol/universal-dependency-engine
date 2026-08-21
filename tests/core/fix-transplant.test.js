'use strict';

const {
  TRANSPLANT_CONFIDENCE,
  BACKPORT_STATUS,
  locateUpstreamFix,
  assessBackport,
  buildTransplantPlan,
} = require('../../src/core/fix-transplant');

// ─── locateUpstreamFix ────────────────────────────────────────────────────────
describe('locateUpstreamFix', () => {
  test('confidence LOW when no manifest or repositoryUrl provided', () => {
    const r = locateUpstreamFix('lodash', '4.17.15', '4.17.21');
    expect(r.confidence).toBe(TRANSPLANT_CONFIDENCE.LOW);
    expect(r.repositoryUrl).toBeNull();
    expect(r.manifestProvided).toBe(false);
  });

  test('confidence MEDIUM when manifest has repository URL but no changelog', () => {
    const manifest = { repository: { url: 'https://github.com/lodash/lodash.git' } };
    const r = locateUpstreamFix('lodash', '4.17.15', '4.17.21', { manifest });
    expect(r.confidence).toBe(TRANSPLANT_CONFIDENCE.MEDIUM);
    expect(r.repositoryUrl).toBe('https://github.com/lodash/lodash');
    expect(r.manifestProvided).toBe(true);
  });

  test('confidence HIGH when manifest has changelog', () => {
    const manifest = {
      repository: 'https://github.com/lodash/lodash',
      changelog:  'Fixed CVE-2021-23337',
    };
    const r = locateUpstreamFix('lodash', '4.17.15', '4.17.21', { manifest });
    expect(r.confidence).toBe(TRANSPLANT_CONFIDENCE.HIGH);
    expect(r.changelogEntry).toBe('Fixed CVE-2021-23337');
  });

  test('strips git+ prefix and .git suffix from repository URL', () => {
    const manifest = { repository: 'git+https://github.com/foo/bar.git' };
    const r = locateUpstreamFix('bar', '1.0.0', '1.0.1', { manifest });
    expect(r.repositoryUrl).toBe('https://github.com/foo/bar');
  });

  test('repositoryUrl override takes precedence over manifest', () => {
    const manifest = { repository: 'https://github.com/old/repo' };
    const r = locateUpstreamFix('pkg', '1.0.0', '1.0.1', {
      manifest,
      repositoryUrl: 'https://github.com/new/repo',
    });
    expect(r.repositoryUrl).toBe('https://github.com/new/repo');
  });

  test('returns pkgName, installedVersion, fixVersion in result', () => {
    const r = locateUpstreamFix('express', '4.18.0', '4.18.2');
    expect(r.pkgName).toBe('express');
    expect(r.installedVersion).toBe('4.18.0');
    expect(r.fixVersion).toBe('4.18.2');
  });
});

// ─── assessBackport ───────────────────────────────────────────────────────────
describe('assessBackport', () => {
  test('BACKPORTABLE for patch-level upgrade', () => {
    const r = assessBackport('4.17.15', '4.17.21');
    expect(r.status).toBe(BACKPORT_STATUS.BACKPORTABLE);
  });

  test('BACKPORTABLE for minor upgrade within threshold', () => {
    const r = assessBackport('4.0.0', '4.1.0');
    expect(r.status).toBe(BACKPORT_STATUS.BACKPORTABLE);
  });

  test('RISKY for minor gap above threshold', () => {
    const r = assessBackport('4.0.0', '4.5.0');
    expect(r.status).toBe(BACKPORT_STATUS.RISKY);
    expect(r.minorGap).toBe(5);
  });

  test('NOT_BACKPORTABLE for major version bump', () => {
    const r = assessBackport('3.2.1', '4.0.0');
    expect(r.status).toBe(BACKPORT_STATUS.NOT_BACKPORTABLE);
    expect(r.reason).toMatch(/Major version bump/);
  });

  test('UNKNOWN when version strings are unparseable', () => {
    const r = assessBackport('not-a-version', '4.0.0');
    expect(r.status).toBe(BACKPORT_STATUS.UNKNOWN);
  });

  test('respects custom maxMinorGap option', () => {
    const r = assessBackport('4.0.0', '4.3.0', { maxMinorGap: 5 });
    expect(r.status).toBe(BACKPORT_STATUS.BACKPORTABLE);
  });
});

// ─── buildTransplantPlan ──────────────────────────────────────────────────────
describe('buildTransplantPlan', () => {
  test('recommended is BACKPORT for patch-level upgrade', () => {
    const plan = buildTransplantPlan('lodash', '4.17.15', '4.17.21');
    expect(plan.recommended).toBe('BACKPORT');
    expect(plan.upstream.pkgName).toBe('lodash');
    expect(plan.backport.status).toBe(BACKPORT_STATUS.BACKPORTABLE);
  });

  test('recommended is FORK_OR_MIGRATE for major bump', () => {
    const plan = buildTransplantPlan('nanoid', '3.3.1', '5.0.0');
    expect(plan.recommended).toBe('FORK_OR_MIGRATE');
    expect(plan.backport.status).toBe(BACKPORT_STATUS.NOT_BACKPORTABLE);
  });

  test('recommended is REVIEW_REQUIRED for risky minor gap', () => {
    const plan = buildTransplantPlan('pkg', '1.0.0', '1.5.0');
    expect(plan.recommended).toBe('REVIEW_REQUIRED');
    expect(plan.backport.status).toBe(BACKPORT_STATUS.RISKY);
  });

  test('forwards manifest opts to locateUpstreamFix', () => {
    const manifest = { repository: 'https://github.com/foo/pkg', changelog: 'fix' };
    const plan = buildTransplantPlan('pkg', '1.0.0', '1.0.1', { manifest });
    expect(plan.upstream.confidence).toBe(TRANSPLANT_CONFIDENCE.HIGH);
    expect(plan.upstream.manifestProvided).toBe(true);
  });
});
