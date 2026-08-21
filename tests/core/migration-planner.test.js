'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  MIGRATION_STRATEGIES,
  ALTERNATIVES_CATALOGUE,
  findAlternatives,
  selectStrategy,
  generateMigrationPlan,
  writeMigrationPlan,
} = require('../../src/core/migration-planner');

// ─── ALTERNATIVES_CATALOGUE ───────────────────────────────────────────────────

test('ALTERNATIVES_CATALOGUE is a non-empty object', () => {
  expect(typeof ALTERNATIVES_CATALOGUE).toBe('object');
  expect(Object.keys(ALTERNATIVES_CATALOGUE).length).toBeGreaterThan(0);
});

test('ALTERNATIVES_CATALOGUE entries have required fields', () => {
  for (const [pkg, alts] of Object.entries(ALTERNATIVES_CATALOGUE)) {
    for (const alt of alts) {
      expect(typeof alt.name).toBe('string');
      expect(typeof alt.reason).toBe('string');
      expect(typeof alt.capabilityScore).toBe('number');
      expect(typeof alt.securityScore).toBe('number');
      expect(['low', 'medium', 'high']).toContain(alt.migrationEffort);
    }
  }
});

// ─── MIGRATION_STRATEGIES ────────────────────────────────────────────────────

test('MIGRATION_STRATEGIES is frozen and contains required values', () => {
  expect(Object.isFrozen(MIGRATION_STRATEGIES)).toBe(true);
  const required = ['DIRECT_UPGRADE', 'MAJOR_BY_MAJOR', 'ADAPTER', 'REPLACEMENT', 'INTERNAL_FORK', 'FEATURE_REMOVAL'];
  for (const s of required) expect(MIGRATION_STRATEGIES[s]).toBe(s);
});

// ─── findAlternatives ────────────────────────────────────────────────────────

test('findAlternatives returns empty array for unknown package', () => {
  expect(findAlternatives('not-a-real-package')).toEqual([]);
});

test('findAlternatives for "request" returns multiple alternatives', () => {
  const alts = findAlternatives('request');
  expect(alts.length).toBeGreaterThan(0);
  for (const alt of alts) {
    expect(typeof alt.compositeScore).toBe('number');
    expect(alt.compositeScore).toBeGreaterThan(0);
    expect(alt.compositeScore).toBeLessThanOrEqual(1.1); // may have org bonus
  }
});

test('findAlternatives returns results sorted by compositeScore descending', () => {
  const alts = findAlternatives('request');
  for (let i = 1; i < alts.length; i++) {
    expect(alts[i - 1].compositeScore).toBeGreaterThanOrEqual(alts[i].compositeScore);
  }
});

test('findAlternatives for "moment" returns dayjs as top result', () => {
  const alts = findAlternatives('moment');
  expect(alts[0].name).toBe('dayjs');
});

test('findAlternatives orgApproved gives a bonus to matching packages', () => {
  const without = findAlternatives('request');
  const withApproved = findAlternatives('request', { orgApproved: ['got'] });
  const gotWith    = withApproved.find(a => a.name === 'got');
  const gotWithout = without.find(a => a.name === 'got');
  expect(gotWith.compositeScore).toBeGreaterThan(gotWithout.compositeScore);
});

// ─── selectStrategy ─────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    libraryName: 'request',
    currentVersion: '2.88.2',
    recommendedVersion: null,
    upgradeType: 'NO_FIX',
    phase: 'C',
    cves: [{ id: 'CVE-2023-28155', severity: 'HIGH' }],
    justification: 'No fix available',
    ...overrides,
  };
}

test('selectStrategy for NO_FIX with no alternatives includes INTERNAL_FORK', () => {
  const strategies = selectStrategy(makeItem({ upgradeType: 'NO_FIX' }), [], null);
  const types = strategies.map(s => s.strategy);
  expect(types).toContain(MIGRATION_STRATEGIES.INTERNAL_FORK);
});

test('selectStrategy always includes FEATURE_REMOVAL as last resort', () => {
  const strategies = selectStrategy(makeItem(), [], null);
  const types = strategies.map(s => s.strategy);
  expect(types).toContain(MIGRATION_STRATEGIES.FEATURE_REMOVAL);
});

test('selectStrategy for MAJOR_BUMP includes DIRECT_UPGRADE', () => {
  const strategies = selectStrategy(makeItem({ upgradeType: 'MAJOR_BUMP', recommendedVersion: '3.0.0' }), [], null);
  const types = strategies.map(s => s.strategy);
  expect(types).toContain(MIGRATION_STRATEGIES.DIRECT_UPGRADE);
});

test('selectStrategy with alternatives includes REPLACEMENT', () => {
  const alts       = findAlternatives('request');
  const strategies = selectStrategy(makeItem({ libraryName: 'request' }), alts, null);
  const types = strategies.map(s => s.strategy);
  expect(types).toContain(MIGRATION_STRATEGIES.REPLACEMENT);
});

test('selectStrategy returns objects with required fields', () => {
  const strategies = selectStrategy(makeItem(), [], null);
  for (const s of strategies) {
    expect(typeof s.strategy).toBe('string');
    expect(typeof s.rationale).toBe('string');
    expect(typeof s.recommended).toBe('boolean');
  }
});

test('selectStrategy with high-usage fingerprint includes ADAPTER', () => {
  const fingerprint = { effortEstimate: 'high', filesWithUsage: 20, usageCount: 50, symbols: [], effortBasis: '' };
  const strategies  = selectStrategy(makeItem({ upgradeType: 'MAJOR_BUMP', recommendedVersion: '3.0.0' }), [], fingerprint);
  const types = strategies.map(s => s.strategy);
  expect(types).toContain(MIGRATION_STRATEGIES.ADAPTER);
});

// ─── generateMigrationPlan ────────────────────────────────────────────────────

test('generateMigrationPlan returns markdown string', () => {
  const plan   = [makeItem({ phase: 'C', upgradeType: 'MAJOR_BUMP', recommendedVersion: '3.0.0' })];
  const output = generateMigrationPlan(plan, { project: 'test', reportDate: '2026-08-21' });
  expect(typeof output).toBe('string');
  expect(output.length).toBeGreaterThan(0);
});

test('generateMigrationPlan includes Phase C items', () => {
  const plan   = [makeItem({ libraryName: 'request', phase: 'C', upgradeType: 'NO_FIX', recommendedVersion: null })];
  const output = generateMigrationPlan(plan);
  expect(output).toContain('request');
  expect(output).toContain('Phase C');
});

test('generateMigrationPlan excludes Phase A/B items', () => {
  const plan = [
    makeItem({ phase: 'A', upgradeType: 'SAFE', recommendedVersion: '2.88.3' }),
    makeItem({ phase: 'C', libraryName: 'nanoid', upgradeType: 'MAJOR_BUMP', recommendedVersion: '5.0.0' }),
  ];
  const output = generateMigrationPlan(plan);
  expect(output).toContain('nanoid');
  // request is Phase A — should not appear in migration plan
  expect(output).not.toContain('request');
});

test('generateMigrationPlan with no Phase C items returns no-plan message', () => {
  const plan   = [makeItem({ phase: 'A', upgradeType: 'SAFE', recommendedVersion: '2.88.3' })];
  const output = generateMigrationPlan(plan);
  expect(output).toContain('no migration plan needed');
});

test('generateMigrationPlan includes alternatives section for known package', () => {
  const plan   = [makeItem({ libraryName: 'request', phase: 'C', upgradeType: 'NO_FIX' })];
  const output = generateMigrationPlan(plan, { reportDate: '2026-08-21' });
  expect(output).toContain('Alternatives');
  expect(output).toContain('axios'); // from catalogue
});

// ─── writeMigrationPlan ───────────────────────────────────────────────────────

test('writeMigrationPlan writes file to disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
  const plan   = [makeItem({ phase: 'C', libraryName: 'request', upgradeType: 'NO_FIX' })];
  const outPath = writeMigrationPlan(plan, tmpDir, { reportDate: '2026-08-21' });
  expect(fs.existsSync(outPath)).toBe(true);
  const content = fs.readFileSync(outPath, 'utf8');
  expect(content).toContain('Migration Plan');
  fs.unlinkSync(outPath);
  fs.rmdirSync(tmpDir);
});
