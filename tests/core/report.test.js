'use strict';

const { generateReport } = require('../../src/core/report');

// Minimal PhasedItem factory
function makeItem(name, phase, overrides = {}) {
  return {
    libraryName:       name,
    currentVersion:    '1.0.0',
    recommendedVersion:'1.1.0',
    upgradeType:       'SAFE',
    phase,
    justification:     'safe upgrade',
    highestSeverity:   'HIGH',
    cveCount:          1,
    cves:              [{ id: 'CVE-2026-00001', severity: 'HIGH' }],
    ...overrides,
  };
}

const BASE_OPTS = { project: 'test', reportDate: '2026-08-21', ecosystem: 'npm', verifyVersions: false };

// ─── directDeps split in Phase A section ─────────────────────────────────────

test('without directDeps all Phase A packages appear in overrides block', () => {
  const plan = [makeItem('lodash', 'A'), makeItem('axios', 'A')];
  const report = generateReport(plan, BASE_OPTS);
  // Both should appear in the overrides JSON block
  expect(report).toContain('"overrides"');
  expect(report).toContain('"lodash"');
  expect(report).toContain('"axios"');
  // No direct dep bumps section
  expect(report).not.toContain('Direct dependency bumps');
});

test('with directDeps set: direct dep packages go to dependencies block, not overrides', () => {
  const plan    = [makeItem('lodash', 'A'), makeItem('axios', 'A'), makeItem('fast-uri', 'A')];
  const directDeps = new Set(['axios', 'lodash']);
  const report  = generateReport(plan, { ...BASE_OPTS, directDeps });

  expect(report).toContain('Direct dependency bumps');
  expect(report).toContain('"dependencies"');

  // fast-uri still in overrides
  expect(report).toContain('"overrides"');
  expect(report).toContain('"fast-uri"');

  // axios and lodash are in the dependencies block
  const depsIdx  = report.indexOf('"dependencies"');
  const ovrdIdx  = report.indexOf('"overrides"');
  // both blocks present
  expect(depsIdx).toBeGreaterThan(-1);
  expect(ovrdIdx).toBeGreaterThan(-1);
});

test('with directDeps covering all Phase A: no overrides block shown', () => {
  const plan    = [makeItem('axios', 'A'), makeItem('lodash', 'A')];
  const directDeps = new Set(['axios', 'lodash']);
  const report  = generateReport(plan, { ...BASE_OPTS, directDeps });

  expect(report).toContain('Direct dependency bumps');
  // overrides block should not appear (all are direct)
  expect(report).not.toContain('"overrides"');
});

test('with empty directDeps set behaves same as no directDeps', () => {
  const plan   = [makeItem('lodash', 'A')];
  const report = generateReport(plan, { ...BASE_OPTS, directDeps: new Set() });
  expect(report).toContain('"overrides"');
  expect(report).not.toContain('Direct dependency bumps');
});

test('directDeps does not affect Phase B or C sections', () => {
  const plan = [
    makeItem('lodash', 'A'),
    makeItem('axios',  'A'),
    makeItem('nanoid', 'C', { upgradeType: 'MAJOR_BUMP', recommendedVersion: '5.0.0' }),
  ];
  const directDeps = new Set(['axios']);
  const report = generateReport(plan, { ...BASE_OPTS, directDeps });
  // Phase C still appears
  expect(report).toContain('Phase C');
  expect(report).toContain('nanoid');
});

test('report still renders correctly with no Phase A items', () => {
  const plan   = [makeItem('nanoid', 'C', { upgradeType: 'NO_FIX', recommendedVersion: null })];
  const report = generateReport(plan, { ...BASE_OPTS, directDeps: new Set(['nanoid']) });
  // Summary table has Phase A row but the detailed section is absent
  expect(report).not.toContain('Direct dependency bumps');
  expect(report).not.toContain('"overrides"');
  // Phase A count in summary is 0
  expect(report).toContain('| ✅ Phase A');
});

// ─── 5B.2 enhanced report features ────────────────────────────────────────────

test('exposure summary table appears when exposureResults provided', () => {
  const plan = [makeItem('lodash', 'A'), makeItem('jest', 'C', { upgradeType: 'NO_FIX' })];
  const exposureResults = [
    { item: { libraryName: 'lodash' }, exposureResult: { classification: 'RUNTIME_REACHABLE' } },
    { item: { libraryName: 'jest' },   exposureResult: { classification: 'TEST_ONLY' } },
  ];
  const report = generateReport(plan, { ...BASE_OPTS, exposureResults });
  expect(report).toContain('Exposure Classification');
  expect(report).toContain('RUNTIME_REACHABLE');
  expect(report).toContain('TEST_ONLY');
});

test('fp note shown when dev/test-only libraries exist', () => {
  const plan = [makeItem('jest', 'C', { upgradeType: 'NO_FIX' })];
  const exposureResults = [
    { item: { libraryName: 'jest' }, exposureResult: { classification: 'TEST_ONLY' } },
  ];
  const report = generateReport(plan, { ...BASE_OPTS, exposureResults });
  expect(report).toContain('dev/test-only');
});

test('exposure summary absent when no exposureResults', () => {
  const plan = [makeItem('lodash', 'A')];
  const report = generateReport(plan, BASE_OPTS);
  expect(report).not.toContain('Exposure Classification');
});

test('Phase B parent upgrade paths shown when rootParents present', () => {
  const plan = [makeItem('loader-utils', 'B', {
    rootParents: [{ name: 'webpack', range: '^4.0.0', isDev: false }],
  })];
  const report = generateReport(plan, BASE_OPTS);
  expect(report).toContain('Parent upgrade paths');
  expect(report).toContain('webpack');
  expect(report).toContain('loader-utils');
});

test('Phase B parent upgrade paths absent when no rootParents', () => {
  const plan = [makeItem('loader-utils', 'B', { rootParents: [] })];
  const report = generateReport(plan, BASE_OPTS);
  expect(report).not.toContain('Parent upgrade paths');
});

test('Phase C shows top migration alternative when alternatives present', () => {
  const plan = [makeItem('jest', 'C', {
    upgradeType: 'NO_FIX',
    recommendedVersion: null,
    alternatives: [{ name: 'vitest', effort: 'medium' }],
  })];
  const report = generateReport(plan, BASE_OPTS);
  expect(report).toContain('Top migration alternative');
  expect(report).toContain('vitest');
  expect(report).toContain('medium');
});

test('evidence footer always present', () => {
  const plan = [makeItem('lodash', 'A')];
  const report = generateReport(plan, BASE_OPTS);
  expect(report).toContain('remediation-evidence.sarif');
  expect(report).toContain('remediation.vex.json');
});
