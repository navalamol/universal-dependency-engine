'use strict';

const { buildComparisonReport, renderComparisonReport } = require('../../src/core/comparison-report');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(name, cveCount = 2) {
  return {
    libraryName: name,
    currentVersion: '1.0.0',
    cves: Array.from({ length: cveCount }, (_, i) => ({ id: `CVE-2024-${i}`, severity: 'HIGH', score: 7 })),
  };
}

function makePhasedItem(name, phase, cveCount = 2, opts = {}) {
  return {
    libraryName: name,
    phase,
    currentVersion: '1.0.0',
    recommendedVersion: phase === 'C' ? null : '2.0.0',
    cveCount,
    cves: Array.from({ length: cveCount }, (_, i) => ({ id: `CVE-2024-${i}`, severity: 'HIGH', score: 7 })),
    highestSeverity: 'HIGH',
    rootParents: opts.rootParents || [],
    alternatives: opts.alternatives || [],
    justification: opts.justification || '',
  };
}

function makeExposure(name, classification) {
  return {
    item: { libraryName: name },
    exposureResult: { classification, confidence: 0.8, evidenceSources: [] },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildComparisonReport', () => {
  const entries = [
    makeEntry('lodash', 3),
    makeEntry('axios', 2),
    makeEntry('webpack', 4),
    makeEntry('jest', 2),
  ];

  const phasedPlan = [
    makePhasedItem('lodash', 'A', 3),
    makePhasedItem('axios', 'A', 2),
    makePhasedItem('webpack', 'B', 4, {
      rootParents: [{ name: 'react-scripts', range: '^4.0.0', isDev: false }],
    }),
    makePhasedItem('jest', 'C', 2, {
      alternatives: [{ name: 'vitest', effort: 'medium' }],
    }),
  ];

  const exposureResults = [
    makeExposure('lodash', 'RUNTIME_REACHABLE'),
    makeExposure('axios', 'RUNTIME_REACHABLE'),
    makeExposure('webpack', 'BUILD_TIME_EXECUTED'),
    makeExposure('jest', 'TEST_ONLY'),
  ];

  let report;
  beforeEach(() => {
    report = buildComparisonReport(entries, phasedPlan, exposureResults, {
      project: 'test-project',
      reportDate: '2026-01-01',
    });
  });

  test('scanner totals match raw entries', () => {
    expect(report.scanner.totalLibraries).toBe(4);
    expect(report.scanner.totalCves).toBe(11);
  });

  test('phase breakdown is correct', () => {
    expect(report.phaseBreakdown.A.libraries).toBe(2);
    expect(report.phaseBreakdown.A.cves).toBe(5);
    expect(report.phaseBreakdown.B.libraries).toBe(1);
    expect(report.phaseBreakdown.B.cves).toBe(4);
    expect(report.phaseBreakdown.C.libraries).toBe(1);
    expect(report.phaseBreakdown.C.cves).toBe(2);
  });

  test('autoCloseable = Phase A + B cves', () => {
    expect(report.engine.autoCloseable).toBe(5 + 4);
  });

  test('requiresAction = Phase C cves', () => {
    expect(report.engine.requiresAction).toBe(2);
  });

  test('notProductionReachable counts dev/test-only libs', () => {
    // webpack = BUILD_TIME_EXECUTED, jest = TEST_ONLY → 2
    expect(report.engine.notProductionReachable).toBe(2);
  });

  test('phaseBParentPaths populated from rootParents', () => {
    expect(report.phaseBParentPaths.length).toBe(1);
    expect(report.phaseBParentPaths[0]).toContain('webpack');
    expect(report.phaseBParentPaths[0]).toContain('react-scripts');
  });

  test('phaseCMigrations populated from alternatives', () => {
    expect(report.phaseCMigrations.length).toBe(1);
    expect(report.phaseCMigrations[0].lib).toBe('jest');
    expect(report.phaseCMigrations[0].alternative).toBe('vitest');
    expect(report.phaseCMigrations[0].effort).toBe('medium');
  });

  test('narrative is non-empty string', () => {
    expect(typeof report.narrative).toBe('string');
    expect(report.narrative.length).toBeGreaterThan(50);
  });

  test('project and reportDate stored', () => {
    expect(report.project).toBe('test-project');
    expect(report.reportDate).toBe('2026-01-01');
  });

  test('handles empty exposureResults gracefully', () => {
    const r = buildComparisonReport(entries, phasedPlan, []);
    expect(r.engine.notProductionReachable).toBe(0);
  });

  test('handles empty phasedPlan gracefully', () => {
    const r = buildComparisonReport(entries, [], []);
    expect(r.engine.autoCloseable).toBe(0);
    expect(r.engine.requiresAction).toBe(0);
  });

  test('handles null inputs gracefully', () => {
    const r = buildComparisonReport(null, null, null);
    expect(r.scanner.totalLibraries).toBe(0);
    expect(r.engine.autoCloseable).toBe(0);
  });
});

describe('renderComparisonReport', () => {
  const report = buildComparisonReport(
    [makeEntry('lodash', 3), makeEntry('jest', 2)],
    [
      makePhasedItem('lodash', 'A', 3),
      makePhasedItem('jest', 'C', 2, { alternatives: [{ name: 'vitest', effort: 'low' }] }),
    ],
    [
      makeExposure('lodash', 'RUNTIME_REACHABLE'),
      makeExposure('jest', 'TEST_ONLY'),
    ],
    { project: 'render-test', reportDate: '2026-01-01' }
  );

  let md;
  beforeEach(() => { md = renderComparisonReport(report); });

  test('contains heading', () => {
    expect(md).toContain('Before / After Comparison');
  });

  test('contains scanner baseline table', () => {
    expect(md).toContain('Naive Scanner');
    expect(md).toContain('Engine');
  });

  test('contains phase distribution table', () => {
    expect(md).toContain('Phase Distribution');
    expect(md).toContain('Auto-apply');
  });

  test('contains migration alternatives section when Phase C exists', () => {
    expect(md).toContain('Migration Alternatives');
    expect(md).toContain('vitest');
  });

  test('contains evidence footer', () => {
    expect(md).toContain('remediation-evidence.sarif');
    expect(md).toContain('remediation.vex.json');
  });

  test('contains value proposition narrative', () => {
    expect(md).toContain('Value Proposition');
    expect(md).toContain('automatically closes');
  });
});
