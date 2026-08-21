'use strict';

const {
  HYGIENE_TYPE,
  detectUnusedDevDeps,
  detectRetirementSignals,
  detectPreventiveUpgrades,
  detectGitAndBranchDeps,
  analyzeHygiene,
} = require('../../src/core/hygiene-advisor');

// ─── detectUnusedDevDeps ──────────────────────────────────────────────────────

test('detectUnusedDevDeps returns empty for no devDependencies', () => {
  expect(detectUnusedDevDeps({})).toEqual([]);
  expect(detectUnusedDevDeps({ dependencies: { lodash: '^4' } })).toEqual([]);
});

test('detectUnusedDevDeps returns empty for null input', () => {
  expect(detectUnusedDevDeps(null)).toEqual([]);
});

test('detectUnusedDevDeps flags devDep not in any script', () => {
  const pkg = {
    devDependencies: { 'some-tool': '^1.0.0', jest: '^29.0.0' },
    scripts: { test: 'jest', build: 'webpack' },
  };
  const findings = detectUnusedDevDeps(pkg);
  const names = findings.map(f => f.package);
  expect(names).toContain('some-tool');
  expect(names).not.toContain('jest'); // jest is in scripts
});

test('detectUnusedDevDeps finding has correct type and evidence', () => {
  const pkg = { devDependencies: { 'unused-dep': '^1.0.0' }, scripts: { test: 'mocha' } };
  const [f] = detectUnusedDevDeps(pkg);
  expect(f.type).toBe(HYGIENE_TYPE.UNUSED_DEV_DEP);
  expect(typeof f.evidence).toBe('string');
  expect(f.autoApplicable).toBe(false);
  expect(f.confidence).toBeGreaterThan(0);
});

test('detectUnusedDevDeps with empty scripts: all devDeps flagged', () => {
  const pkg = { devDependencies: { a: '^1', b: '^2' }, scripts: {} };
  const findings = detectUnusedDevDeps(pkg);
  expect(findings).toHaveLength(2);
});

// ─── detectRetirementSignals ──────────────────────────────────────────────────

test('detectRetirementSignals returns empty for no registryMeta', () => {
  const entries = [{ libraryName: 'lodash', currentVersion: '4.17.11' }];
  expect(detectRetirementSignals(entries, null)).toEqual([]);
});

test('detectRetirementSignals flags package with deprecated field', () => {
  const entries = [{ libraryName: 'request', currentVersion: '2.88.2' }];
  const meta    = new Map([['request', { deprecated: 'Package deprecated, use got instead' }]]);
  const [f] = detectRetirementSignals(entries, meta);
  expect(f.type).toBe(HYGIENE_TYPE.DEPRECATED);
  expect(f.package).toBe('request');
  expect(f.evidence).toContain('deprecated');
  expect(f.autoApplicable).toBe(false);
});

test('detectRetirementSignals does not flag package without deprecated field', () => {
  const entries = [{ libraryName: 'axios', currentVersion: '1.6.0' }];
  const meta    = new Map([['axios', { deprecated: false }]]);
  expect(detectRetirementSignals(entries, meta)).toEqual([]);
});

test('detectRetirementSignals returns empty for null entries', () => {
  expect(detectRetirementSignals(null, new Map())).toEqual([]);
});

// ─── detectPreventiveUpgrades ─────────────────────────────────────────────────

test('detectPreventiveUpgrades returns empty for no installed packages', () => {
  expect(detectPreventiveUpgrades([], [], null)).toEqual([]);
});

test('detectPreventiveUpgrades skips packages already in CVE entries', () => {
  const entries   = [{ libraryName: 'lodash' }];
  const installed = [{ name: 'lodash', version: '4.17.11' }];
  const versions  = new Map([['lodash', ['4.17.21']]]);
  expect(detectPreventiveUpgrades(entries, installed, versions)).toEqual([]);
});

test('detectPreventiveUpgrades flags patch upgrade for non-CVE package', () => {
  const installed = [{ name: 'axios', version: '1.6.0' }];
  const versions  = new Map([['axios', ['1.6.0', '1.6.1', '1.6.8']]]);
  const [f] = detectPreventiveUpgrades([], installed, versions);
  expect(f.type).toBe(HYGIENE_TYPE.PREVENTIVE_UPGRADE);
  expect(f.package).toBe('axios');
  expect(f.upgradeType).toBe('patch');
  expect(f.autoApplicable).toBe(false);
});

test('detectPreventiveUpgrades does not suggest major bumps', () => {
  const installed = [{ name: 'moment', version: '2.29.4' }];
  const versions  = new Map([['moment', ['2.29.4', '3.0.0']]]);
  const findings  = detectPreventiveUpgrades([], installed, versions);
  // 3.0.0 is a major bump — should not be suggested as preventive
  expect(findings.filter(f => f.package === 'moment')).toHaveLength(0);
});

// ─── detectGitAndBranchDeps ───────────────────────────────────────────────────

test('detectGitAndBranchDeps returns empty for registry-only deps', () => {
  const pkg = { dependencies: { lodash: '^4.17.21' }, devDependencies: { jest: '^29.0.0' } };
  expect(detectGitAndBranchDeps(pkg)).toEqual([]);
});

test('detectGitAndBranchDeps flags git+ URL', () => {
  const pkg = { dependencies: { 'my-lib': 'git+https://github.com/org/my-lib.git' } };
  const [f] = detectGitAndBranchDeps(pkg);
  expect(f.type).toBe(HYGIENE_TYPE.GIT_DEP);
  expect(f.package).toBe('my-lib');
  expect(f.autoApplicable).toBe(false);
});

test('detectGitAndBranchDeps flags github: shorthand', () => {
  const pkg = { dependencies: { 'some-pkg': 'github:org/some-pkg' } };
  const [f] = detectGitAndBranchDeps(pkg);
  expect(f.type).toBe(HYGIENE_TYPE.GIT_DEP);
});

test('detectGitAndBranchDeps returns empty for null', () => {
  expect(detectGitAndBranchDeps(null)).toEqual([]);
});

// ─── analyzeHygiene ───────────────────────────────────────────────────────────

test('analyzeHygiene returns findings and summary', () => {
  const pkg = {
    devDependencies: { 'unused-tool': '^1.0.0' },
    scripts:         { test: 'jest' },
  };
  const { findings, summary } = analyzeHygiene(pkg, []);
  expect(Array.isArray(findings)).toBe(true);
  expect(typeof summary.total).toBe('number');
  expect(summary.total).toBe(findings.length);
  expect(typeof summary.byType).toBe('object');
});

test('analyzeHygiene summary.autoApplicable is always 0 (all are review-only)', () => {
  const pkg = { devDependencies: { 'unused': '^1.0.0' }, scripts: { test: 'jest' } };
  const { summary } = analyzeHygiene(pkg, []);
  expect(summary.autoApplicable).toBe(0);
});

test('analyzeHygiene handles empty packageJson and entries gracefully', () => {
  const { findings, summary } = analyzeHygiene({}, []);
  expect(Array.isArray(findings)).toBe(true);
  expect(summary.total).toBe(0);
});
