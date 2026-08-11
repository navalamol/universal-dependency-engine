'use strict';

const path = require('path');
const { parseReport } = require('../../src/providers/mend');
const { buildResolutionPlan } = require('../../src/core/semver-engine');
const { applyPhases } = require('../../src/core/phases');

const REPORT_PATH = path.join(__dirname, '../../input/reports/GH_ui-platform_dev-vulnerability-report.json');

describe('Regression — ui-platform Mend report', () => {
  let phasedItems;

  beforeAll(() => {
    const entries = parseReport(REPORT_PATH);
    const plan    = buildResolutionPlan(entries);
    phasedItems   = applyPhases(plan, null);
  });

  test('parses 8 distinct libraries', () => {
    const libraries = buildResolutionPlan(parseReport(REPORT_PATH));
    expect(libraries.length).toBe(8);
  });

  test('Phase A count is 5', () => {
    const phaseA = phasedItems.filter(i => i.phase === 'A');
    expect(phaseA.length).toBe(5);
  });

  test('Phase B count is 0', () => {
    const phaseB = phasedItems.filter(i => i.phase === 'B');
    expect(phaseB.length).toBe(0);
  });

  test('Phase C count is 3', () => {
    const phaseC = phasedItems.filter(i => i.phase === 'C');
    expect(phaseC.length).toBe(3);
  });

  test('Phase A includes fast-uri, socket.io-parser, postcss, unzipper, axios', () => {
    const phaseANames = phasedItems.filter(i => i.phase === 'A').map(i => i.libraryName);
    expect(phaseANames).toContain('fast-uri');
    expect(phaseANames).toContain('socket.io-parser');
    expect(phaseANames).toContain('postcss');
    expect(phaseANames).toContain('unzipper');
    expect(phaseANames).toContain('axios');
  });

  test('nanoid is Phase C (MAJOR_BUMP)', () => {
    const nanoid = phasedItems.find(i => i.libraryName === 'nanoid');
    expect(nanoid).toBeDefined();
    expect(nanoid.phase).toBe('C');
    expect(nanoid.upgradeType).toBe('MAJOR_BUMP');
  });
});
