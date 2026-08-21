'use strict';

/**
 * Contract tests — verify all entry points (CLI pipeline, orchestrator, portfolio-runner)
 * produce equivalent phase decisions for the same input.
 *
 * These tests mock no logic: they run the actual pipeline end-to-end so that
 * a regression in any layer surfaces here, not just in unit tests.
 */

const path = require('path');
const fs   = require('fs');

const REPORT_PATH = path.join(__dirname, '../../input/reports/GH_ui-platform_dev-vulnerability-report.json');

// Skip the suite gracefully when the fixture is absent (CI without real fixture)
const SKIP = !fs.existsSync(REPORT_PATH);

const describeOrSkip = SKIP ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the legacy direct-pipeline path (mirrors what mendfix.js does) */
function legacyPipeline(reportPath) {
  const { parseReport }       = require('../../src/providers/mend');
  const { buildResolutionPlan } = require('../../src/core/semver-engine');
  const { applyPhases }         = require('../../src/core/phases');
  const { enrichWithConfidence } = require('../../src/core/confidence');
  const { enrichWithPaths }      = require('../../src/core/remediation-paths');

  const entries  = parseReport(reportPath);
  let plan       = buildResolutionPlan(entries);
  let phasedPlan = applyPhases(plan, null);
  phasedPlan     = enrichWithConfidence(phasedPlan, null);
  phasedPlan     = enrichWithPaths(phasedPlan, entries);
  return phasedPlan;
}

/** Summarize a phasedPlan for comparison */
function summarize(phasedPlan) {
  return {
    totalLibraries: phasedPlan.length,
    phaseACnt: phasedPlan.filter(i => i.phase === 'A').length,
    phaseBCnt: phasedPlan.filter(i => i.phase === 'B').length,
    phaseCCnt: phasedPlan.filter(i => i.phase === 'C').length,
    names: phasedPlan.map(i => i.libraryName).sort(),
    decisions: phasedPlan.map(i => ({ name: i.libraryName, phase: i.phase, upgrade: i.upgradeType }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Contract: orchestrator vs legacy direct-pipeline
// ---------------------------------------------------------------------------

describeOrSkip('Contract — orchestrator vs direct pipeline', () => {
  let orchestratorResult;
  let legacyResult;

  beforeAll(async () => {
    const { runAnalysisPipeline } = require('../../orchestrator');
    const result = await runAnalysisPipeline({ reportPath: REPORT_PATH });
    orchestratorResult = result.phasedPlan;
    legacyResult = legacyPipeline(REPORT_PATH);
  });

  test('same library count', () => {
    expect(orchestratorResult.length).toBe(legacyResult.length);
  });

  test('same Phase A count', () => {
    expect(orchestratorResult.filter(i => i.phase === 'A').length)
      .toBe(legacyResult.filter(i => i.phase === 'A').length);
  });

  test('same Phase B count', () => {
    expect(orchestratorResult.filter(i => i.phase === 'B').length)
      .toBe(legacyResult.filter(i => i.phase === 'B').length);
  });

  test('same Phase C count', () => {
    expect(orchestratorResult.filter(i => i.phase === 'C').length)
      .toBe(legacyResult.filter(i => i.phase === 'C').length);
  });

  test('same library names', () => {
    const oNames = orchestratorResult.map(i => i.libraryName).sort();
    const lNames = legacyResult.map(i => i.libraryName).sort();
    expect(oNames).toEqual(lNames);
  });

  test('same phase decision per library', () => {
    expect(summarize(orchestratorResult).decisions)
      .toEqual(summarize(legacyResult).decisions);
  });

  test('orchestrator adds evidence field (enrichWithConfidence ran)', () => {
    const withEvidence = orchestratorResult.filter(i => i.evidence);
    expect(withEvidence.length).toBeGreaterThan(0);
  });

  test('orchestrator adds recommendedPath field (enrichWithPaths ran)', () => {
    const withPath = orchestratorResult.filter(i => i.recommendedPath);
    expect(withPath.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Contract: orchestrator vs portfolio-runner analyzeRepo
// ---------------------------------------------------------------------------

describeOrSkip('Contract — orchestrator vs portfolio-runner', () => {
  let orchestratorResult;
  let portfolioResult;

  beforeAll(async () => {
    const { runAnalysisPipeline } = require('../../orchestrator');
    const { analyzeRepo }         = require('../../portfolio-runner');

    const [oRes, pRes] = await Promise.all([
      runAnalysisPipeline({ reportPath: REPORT_PATH }),
      analyzeRepo({ name: 'test-repo', report: REPORT_PATH }),
    ]);

    orchestratorResult = oRes.phasedPlan;
    portfolioResult    = [...pRes.phaseA, ...pRes.phaseB, ...pRes.phaseC];
  });

  test('same library count', () => {
    expect(orchestratorResult.length).toBe(portfolioResult.length);
  });

  test('same Phase A count', () => {
    expect(orchestratorResult.filter(i => i.phase === 'A').length)
      .toBe(portfolioResult.filter(i => i.phase === 'A').length);
  });

  test('same Phase C count', () => {
    expect(orchestratorResult.filter(i => i.phase === 'C').length)
      .toBe(portfolioResult.filter(i => i.phase === 'C').length);
  });

  test('same phase decision per library', () => {
    expect(summarize(orchestratorResult).decisions)
      .toEqual(summarize(portfolioResult).decisions);
  });
});

// ---------------------------------------------------------------------------
// Baseline: orchestrator regression A:5 B:0 C:3
// ---------------------------------------------------------------------------

describeOrSkip('Orchestrator regression — ui-platform baseline', () => {
  let phasedPlan;

  beforeAll(async () => {
    const { runAnalysisPipeline } = require('../../orchestrator');
    const result = await runAnalysisPipeline({ reportPath: REPORT_PATH });
    phasedPlan = result.phasedPlan;
  });

  test('Phase A: 5', () => expect(phasedPlan.filter(i => i.phase === 'A').length).toBe(5));
  test('Phase B: 0', () => expect(phasedPlan.filter(i => i.phase === 'B').length).toBe(0));
  test('Phase C: 3', () => expect(phasedPlan.filter(i => i.phase === 'C').length).toBe(3));
  test('ecosystem is npm', async () => {
    const { runAnalysisPipeline } = require('../../orchestrator');
    const result = await runAnalysisPipeline({ reportPath: REPORT_PATH });
    expect(result.ecosystem).toBe('npm');
  });
});
