'use strict';

/**
 * Integration test for `mendfix demo` command.
 *
 * Exit gate (from Batch 5A specification):
 *   Phase A ≥ 4, Phase B ≥ 2, Phase C ≥ 2
 *   D1A fires on ≥ 4 findings (RUNTIME_REACHABLE or dev/build-class)
 *   All 4 scanner reports produce equivalent phase distributions
 */

const path = require('path');
const { runAnalysisPipeline } = require('../../orchestrator');

const DEMO_DIR   = path.join(__dirname, '../../fixtures/demo-corpus');
const LOCK_FILE  = path.join(DEMO_DIR, 'npm/package-lock.json');
const PKG_JSON   = path.join(DEMO_DIR, 'npm/package.json');
const REPORTS    = path.join(DEMO_DIR, 'reports');

const SCANNERS = [
  { name: 'mend',      file: path.join(REPORTS, 'mend-report.json') },
  { name: 'snyk',      file: path.join(REPORTS, 'snyk-report.json') },
  { name: 'dependabot',file: path.join(REPORTS, 'dependabot-report.json') },
  { name: 'osv',       file: path.join(REPORTS, 'osv-report.json') },
];

async function runPipeline(reportPath) {
  return runAnalysisPipeline({
    reportPath,
    lockFilePath:    LOCK_FILE,
    packageJsonPath: PKG_JSON,
    classifyExposure: true,
  });
}

describe('demo-command — Batch 5A exit gate', () => {
  let results;

  beforeAll(async () => {
    results = await Promise.all(SCANNERS.map(s => runPipeline(s.file)));
  }, 30000);

  test.each(SCANNERS.map((s, i) => [s.name, i]))('Phase A ≥ 4 for %s', (name, idx) => {
    const { phasedPlan } = results[idx];
    const count = phasedPlan.filter(i => i.phase === 'A').length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test.each(SCANNERS.map((s, i) => [s.name, i]))('Phase B ≥ 2 for %s', (name, idx) => {
    const { phasedPlan } = results[idx];
    const count = phasedPlan.filter(i => i.phase === 'B').length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test.each(SCANNERS.map((s, i) => [s.name, i]))('Phase C ≥ 2 for %s', (name, idx) => {
    const { phasedPlan } = results[idx];
    const count = phasedPlan.filter(i => i.phase === 'C').length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test.each(SCANNERS.map((s, i) => [s.name, i]))('D1A fires on ≥ 4 findings for %s', (name, idx) => {
    const { exposureResults } = results[idx];
    expect(Array.isArray(exposureResults)).toBe(true);
    const classified = (exposureResults || []).filter(r =>
      r.exposureResult && r.exposureResult.classification !== 'UNKNOWN_EXPOSURE'
    );
    expect(classified.length).toBeGreaterThanOrEqual(4);
  });

  test('all 4 scanner reports produce equivalent phase distributions', () => {
    const distributions = results.map(({ phasedPlan }) => ({
      A: phasedPlan.filter(i => i.phase === 'A').length,
      B: phasedPlan.filter(i => i.phase === 'B').length,
      C: phasedPlan.filter(i => i.phase === 'C').length,
    }));
    const [first, ...rest] = distributions;
    for (const dist of rest) {
      expect(dist).toEqual(first);
    }
  });

  test('baseline test report still produces A:5 B:0 C:3', async () => {
    const BASELINE = 'D:/Automation/input/reports/GH_ui-platform_dev-vulnerability-report.json';
    const fs = require('fs');
    if (!fs.existsSync(BASELINE)) {
      return; // skip when baseline report not present
    }
    const { runAnalysisPipeline: run } = require('../../orchestrator');
    const { phasedPlan } = await run({ reportPath: BASELINE });
    expect(phasedPlan.filter(i => i.phase === 'A').length).toBe(5);
    expect(phasedPlan.filter(i => i.phase === 'B').length).toBe(0);
    expect(phasedPlan.filter(i => i.phase === 'C').length).toBe(3);
  });
});
