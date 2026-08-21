'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { computeKPIs, generateKPIReport, writeKPIReport } = require('../../src/core/kpi-report');
const { OUTCOMES, EXPOSURE } = require('../../src/core/evidence-model');

// ─── Fixture factory ──────────────────────────────────────────────────────────

function makeBundle(overrides = {}) {
  return {
    schemaVersion: '1.0',
    libraryName:   'lodash',
    currentVersion:'4.17.11',
    fixVersion:    '4.17.21',
    phase:         'A',
    outcome:       OUTCOMES.FIXED,
    upgradeType:   'SAFE',
    cves:          [{ id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2 }],
    semver:        { upgradeType: 'SAFE', rangeViolation: null },
    lockFile:      { depChain: [], rootParents: [] },
    exposure:      { classification: EXPOSURE.UNKNOWN_EXPOSURE, confidence: null, evidenceSources: [] },
    verification:  null,
    rescan:        null,
    ...overrides,
  };
}

// ─── computeKPIs — empty input ────────────────────────────────────────────────

test('computeKPIs returns zero-valued KPIs for empty array', () => {
  const kpis = computeKPIs([]);
  expect(kpis.totalFindings).toBe(0);
  expect(kpis.remediatedCount).toBe(0);
  expect(kpis.verificationPassRate).toBeNull();
  expect(kpis.rescanClosureRate).toBeNull();
  expect(kpis.cvesAddressed).toBe(0);
});

test('computeKPIs returns zero-valued KPIs for null', () => {
  const kpis = computeKPIs(null);
  expect(kpis.totalFindings).toBe(0);
});

// ─── computeKPIs — basic counts ───────────────────────────────────────────────

test('computeKPIs totalFindings = bundle count', () => {
  const kpis = computeKPIs([makeBundle(), makeBundle({ libraryName: 'axios' })]);
  expect(kpis.totalFindings).toBe(2);
});

test('computeKPIs remediatedCount = FIXED outcomes only', () => {
  const kpis = computeKPIs([
    makeBundle({ outcome: OUTCOMES.FIXED }),
    makeBundle({ outcome: OUTCOMES.REQUIRES_MIGRATION }),
    makeBundle({ outcome: OUTCOMES.NO_SAFE_PATH }),
  ]);
  expect(kpis.remediatedCount).toBe(1);
});

test('computeKPIs phaseDistribution counts are exact', () => {
  const kpis = computeKPIs([
    makeBundle({ phase: 'A' }),
    makeBundle({ phase: 'A' }),
    makeBundle({ phase: 'B' }),
    makeBundle({ phase: 'C' }),
  ]);
  expect(kpis.phaseDistribution).toEqual({ A: 2, B: 1, C: 1 });
});

test('computeKPIs CVE IDs are deduplicated across bundles', () => {
  const cve = [{ id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2 }];
  const kpis = computeKPIs([
    makeBundle({ cves: cve }),
    makeBundle({ libraryName: 'axios', cves: cve }), // same CVE
    makeBundle({ libraryName: 'semver', cves: [{ id: 'CVE-2022-25883', severity: 'HIGH', score: 7.5 }] }),
  ]);
  expect(kpis.cvesAddressed).toBe(2); // only 2 unique
});

// ─── computeKPIs — verification rate ─────────────────────────────────────────

test('computeKPIs verificationPassRate is null when no verifications ran', () => {
  const kpis = computeKPIs([makeBundle()]);
  expect(kpis.verificationPassRate).toBeNull();
});

test('computeKPIs verificationPassRate = passed / ran', () => {
  const kpis = computeKPIs([
    makeBundle({ verification: { passed: true,  commands: [], durationMs: 1000 } }),
    makeBundle({ verification: { passed: true,  commands: [], durationMs: 2000 } }),
    makeBundle({ verification: { passed: false, commands: [], durationMs: 500  } }),
  ]);
  expect(kpis.verificationPassRate).toBeCloseTo(2 / 3);
});

// ─── computeKPIs — rescan closure rate ───────────────────────────────────────

test('computeKPIs rescanClosureRate is null when no rescans ran', () => {
  expect(computeKPIs([makeBundle()]).rescanClosureRate).toBeNull();
});

test('computeKPIs rescanClosureRate = RESOLVED_AND_RESCANNED / total rescanned', () => {
  const kpis = computeKPIs([
    makeBundle({ rescan: { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: [] } }),
    makeBundle({ rescan: { status: 'RESOLVED_NOT_RESCANNED' } }),
    makeBundle({ rescan: { status: 'VERIFICATION_FAILED', remainingCveIds: ['CVE-X'] } }),
  ]);
  expect(kpis.rescanClosureRate).toBeCloseTo(1 / 3);
});

// ─── computeKPIs — exposure breakdown ────────────────────────────────────────

test('computeKPIs exposureBreakdown counts per classification', () => {
  const kpis = computeKPIs([
    makeBundle({ exposure: { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.9, evidenceSources: [] } }),
    makeBundle({ exposure: { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.9, evidenceSources: [] } }),
    makeBundle({ exposure: { classification: EXPOSURE.TEST_ONLY, confidence: 0.8, evidenceSources: [] } }),
  ]);
  expect(kpis.exposureBreakdown[EXPOSURE.RUNTIME_REACHABLE]).toBe(2);
  expect(kpis.exposureBreakdown[EXPOSURE.TEST_ONLY]).toBe(1);
});

test('computeKPIs runtimeReachableFixed counts RUNTIME_REACHABLE + FIXED', () => {
  const kpis = computeKPIs([
    makeBundle({ outcome: OUTCOMES.FIXED, exposure: { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.9, evidenceSources: [] } }),
    makeBundle({ outcome: OUTCOMES.FIXED, exposure: { classification: EXPOSURE.TEST_ONLY, confidence: 0.8, evidenceSources: [] } }),
    makeBundle({ outcome: OUTCOMES.REQUIRES_MIGRATION, exposure: { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.9, evidenceSources: [] } }),
  ]);
  expect(kpis.runtimeReachableFixed).toBe(1);
});

// ─── computeKPIs — engineer time estimate ────────────────────────────────────

test('computeKPIs estimates.engineerTimeSavedMinutes = Phase A count × 15', () => {
  const kpis = computeKPIs([
    makeBundle({ phase: 'A' }),
    makeBundle({ phase: 'A' }),
    makeBundle({ phase: 'C' }),
  ]);
  expect(kpis.estimates.engineerTimeSavedMinutes).toBe(30); // 2 × 15
});

// ─── generateKPIReport ────────────────────────────────────────────────────────

test('generateKPIReport returns a non-empty markdown string', () => {
  const report = generateKPIReport([makeBundle()], { project: 'test-proj', reportDate: '2026-08-21' });
  expect(typeof report).toBe('string');
  expect(report.length).toBeGreaterThan(0);
});

test('generateKPIReport contains project name', () => {
  const report = generateKPIReport([makeBundle()], { project: 'ui-platform', reportDate: '2026-08-21' });
  expect(report).toContain('ui-platform');
});

test('generateKPIReport contains measured counts (not fabricated)', () => {
  const bundles = [makeBundle(), makeBundle({ libraryName: 'axios' })];
  const report  = generateKPIReport(bundles, { reportDate: '2026-08-21' });
  expect(report).toContain('2'); // totalFindings=2 appears somewhere
  expect(report).toContain('No verifications ran');
});

test('generateKPIReport shows estimate disclaimer', () => {
  const report = generateKPIReport([makeBundle({ phase: 'A' })], { reportDate: '2026-08-21' });
  expect(report).toContain('estimate');
});

test('generateKPIReport shows verification pass rate when verifications ran', () => {
  const bundles = [
    makeBundle({ verification: { passed: true, commands: [], durationMs: 1000 } }),
    makeBundle({ libraryName: 'axios', verification: { passed: false, commands: [], durationMs: 500, failureReason: 'test failed' } }),
  ];
  const report = generateKPIReport(bundles, { reportDate: '2026-08-21' });
  expect(report).toContain('%'); // shows a percentage
});

// ─── writeKPIReport ───────────────────────────────────────────────────────────

test('writeKPIReport writes a file and returns the path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-test-'));
  const outPath = writeKPIReport([makeBundle()], tmpDir, { project: 'test', reportDate: '2026-08-21' });
  expect(fs.existsSync(outPath)).toBe(true);
  const content = fs.readFileSync(outPath, 'utf8');
  expect(content).toContain('Pilot KPI Report');
  fs.unlinkSync(outPath);
  fs.rmdirSync(tmpDir);
});
