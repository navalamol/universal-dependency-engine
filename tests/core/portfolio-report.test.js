'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { generatePortfolioReport, writePortfolioReport } = require('../../src/core/portfolio-report');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepo(overrides = {}) {
  return {
    name:           'my-org/my-repo',
    ecosystem:      'npm',
    provider:       'snyk',
    status:         'ok',
    error:          null,
    totalLibraries: 3,
    totalCves:      5,
    phaseA: [
      { libraryName: 'lodash',  currentVersion: '4.17.20', recommendedVersion: '4.17.21', upgradeType: 'SAFE', cves: [] },
    ],
    phaseB: [
      { libraryName: 'axios',   currentVersion: '0.21.0',  recommendedVersion: '0.21.4',  upgradeType: 'SAFE', cves: [] },
    ],
    phaseC: [
      { libraryName: 'nanoid',  currentVersion: '3.1.0',   recommendedVersion: '5.0.0',   upgradeType: 'MAJOR_BUMP', cves: [], probableFalsePositive: false },
    ],
    highestSeverity: 'HIGH',
    criticalCount:  0,
    highCount:      3,
    mediumCount:    2,
    lowCount:       0,
    ...overrides,
  };
}

function makePortfolio(repos = [], overrides = {}) {
  const totalPhaseA = repos.reduce((n, r) => n + (r.phaseA || []).length, 0);
  const totalPhaseB = repos.reduce((n, r) => n + (r.phaseB || []).length, 0);
  const totalPhaseC = repos.reduce((n, r) => n + (r.phaseC || []).length, 0);
  return {
    repos,
    totalRepos:     repos.length,
    totalCves:      repos.reduce((n, r) => n + (r.totalCves || 0), 0),
    totalLibraries: repos.reduce((n, r) => n + (r.totalLibraries || 0), 0),
    totalPhaseA,
    totalPhaseB,
    totalPhaseC,
    criticalCount:  repos.reduce((n, r) => n + (r.criticalCount || 0), 0),
    highCount:      repos.reduce((n, r) => n + (r.highCount || 0), 0),
    mediumCount:    repos.reduce((n, r) => n + (r.mediumCount || 0), 0),
    lowCount:       repos.reduce((n, r) => n + (r.lowCount || 0), 0),
    errorCount:     repos.filter(r => r.status === 'error').length,
    runDate:        '2026-08-12',
    outDir:         '/tmp/portfolio-output',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generatePortfolioReport
// ---------------------------------------------------------------------------

describe('generatePortfolioReport', () => {
  test('includes title and date', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo()]));
    expect(report).toContain('# Portfolio Vulnerability Report');
    expect(report).toContain('**Date:** 2026-08-12');
  });

  test('includes repo count and total CVEs', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo(), makeRepo({ name: 'r2' })]));
    expect(report).toContain('**Repos scanned:** 2');
    expect(report).toContain('**Total CVEs:** 10');
  });

  test('severity summary shows only non-zero rows', () => {
    const repo = makeRepo({ criticalCount: 0, highCount: 3, mediumCount: 2, lowCount: 0 });
    const portfolio = makePortfolio([repo], { criticalCount: 0, highCount: 3, mediumCount: 2, lowCount: 0 });
    const report = generatePortfolioReport(portfolio);
    expect(report).toContain('🟠 HIGH');
    expect(report).toContain('🟡 MEDIUM');
    expect(report).not.toContain('🔴 CRITICAL');
    expect(report).not.toContain('🟢 LOW');
  });

  test('severity summary shows NONE row when all zero', () => {
    const portfolio = makePortfolio([], { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 });
    const report = generatePortfolioReport(portfolio);
    expect(report).toContain('⚪ NONE');
  });

  test('phase distribution table contains all three phases', () => {
    const repo = makeRepo();
    const portfolio = makePortfolio([repo], { totalPhaseA: 1, totalPhaseB: 1, totalPhaseC: 1 });
    const report = generatePortfolioReport(portfolio);
    expect(report).toContain('Phase A (Auto-apply)');
    expect(report).toContain('Phase B (Review first)');
    expect(report).toContain('Phase C (Manual review)');
    expect(report).toContain('95–100%');
    expect(report).toContain('60–95%');
    expect(report).toContain('<60%');
  });

  test('repo summary table shows ok repo with badge', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo()]));
    expect(report).toContain('my-org/my-repo');
    expect(report).toContain('🟠 OK');
    expect(report).toContain('npm');
  });

  test('repo summary table shows error repo with ERROR status', () => {
    const errRepo = {
      name: 'broken-repo',
      status: 'error',
      error: 'file not found',
      phaseA: [], phaseB: [], phaseC: [],
      totalCves: 0, totalLibraries: 0,
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      highestSeverity: 'NONE',
    };
    const report = generatePortfolioReport(makePortfolio([errRepo]));
    expect(report).toContain('broken-repo');
    expect(report).toContain('❌ ERROR');
  });

  test('error section shows error message', () => {
    const errRepo = {
      name: 'broken',
      status: 'error',
      error: 'Cannot read file: /missing.json',
      phaseA: [], phaseB: [], phaseC: [],
      totalCves: 0, totalLibraries: 0,
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      highestSeverity: 'NONE',
    };
    const report = generatePortfolioReport(makePortfolio([errRepo]));
    expect(report).toContain('## Errors');
    expect(report).toContain('Cannot read file: /missing.json');
  });

  test('per-repo detail shows Phase A items with versions', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo()]));
    expect(report).toContain('`lodash`: 4.17.20 → 4.17.21');
  });

  test('per-repo detail shows Phase B items', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo()]));
    expect(report).toContain('`axios`: 0.21.0 → 0.21.4');
  });

  test('per-repo detail shows Phase B parent upgrade paths when present', () => {
    const repo = makeRepo({
      phaseB: [{
        libraryName: 'vuln-child',
        currentVersion: '1.0.0',
        recommendedVersion: null,
        upgradeType: 'MAJOR_BUMP',
        cves: [],
        parentUpgradePaths: [
          { parent: 'parent-pkg', parentUpgradeVersion: '2.5.0' },
        ],
      }],
    });
    const report = generatePortfolioReport(makePortfolio([repo]));
    expect(report).toContain('parent-pkg@2.5.0');
  });

  test('per-repo detail shows Phase C items with NO FIX', () => {
    const repo = makeRepo({
      phaseC: [{
        libraryName: 'no-fix-pkg',
        currentVersion: '3.0.0',
        recommendedVersion: null,
        upgradeType: 'NO_FIX',
        cves: [],
        probableFalsePositive: false,
      }],
    });
    const report = generatePortfolioReport(makePortfolio([repo]));
    expect(report).toContain('`no-fix-pkg`: 3.0.0 → NO FIX [NO_FIX]');
  });

  test('per-repo detail flags probable false positive', () => {
    const repo = makeRepo({
      phaseC: [{
        libraryName: 'fp-pkg',
        currentVersion: '1.0.0',
        recommendedVersion: null,
        upgradeType: 'NO_FIX',
        cves: [],
        probableFalsePositive: true,
      }],
    });
    const report = generatePortfolioReport(makePortfolio([repo]));
    expect(report).toContain('probable false positive');
  });

  test('recommended action order sorted by critical first', () => {
    const repoLow  = makeRepo({ name: 'low-risk',  criticalCount: 0, highCount: 1, totalCves: 2 });
    const repoCrit = makeRepo({ name: 'high-risk', criticalCount: 3, highCount: 2, totalCves: 5 });
    const report = generatePortfolioReport(makePortfolio([repoLow, repoCrit], {
      criticalCount: 3, highCount: 3, mediumCount: 0, lowCount: 0,
    }));
    const sectionStart = report.indexOf('## Recommended Action Order');
    expect(sectionStart).toBeGreaterThan(-1);
    const section  = report.slice(sectionStart);
    const critIdx  = section.indexOf('high-risk');
    const lowIdx   = section.indexOf('low-risk');
    expect(critIdx).toBeLessThan(lowIdx);
  });

  test('no action order section when no actionable repos', () => {
    const repo = makeRepo({ phaseA: [], phaseB: [], phaseC: [], totalCves: 0 });
    const report = generatePortfolioReport(makePortfolio([repo]));
    expect(report).not.toContain('## Recommended Action Order');
  });

  test('action order includes Phase A count note', () => {
    const report = generatePortfolioReport(makePortfolio([makeRepo()]));
    expect(report).toContain('Phase A (auto-apply)');
    expect(report).toContain('1 Phase A');
  });

  test('empty portfolio renders without crashing', () => {
    const portfolio = makePortfolio([], {
      totalPhaseA: 0, totalPhaseB: 0, totalPhaseC: 0,
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
    });
    const report = generatePortfolioReport(portfolio);
    expect(report).toContain('# Portfolio Vulnerability Report');
    expect(report).toContain('**Repos scanned:** 0');
  });
});

// ---------------------------------------------------------------------------
// writePortfolioReport
// ---------------------------------------------------------------------------

describe('writePortfolioReport', () => {
  test('writes portfolio-report.md and returns its path', () => {
    const tmpDir = path.join(os.tmpdir(), `portfolio-write-test-${Date.now()}`);
    const portfolio = makePortfolio([makeRepo()]);

    const reportPath = writePortfolioReport(portfolio, tmpDir);

    expect(reportPath).toBe(path.join(tmpDir, 'portfolio-report.md'));
    expect(fs.existsSync(reportPath)).toBe(true);
    const content = fs.readFileSync(reportPath, 'utf8');
    expect(content).toContain('# Portfolio Vulnerability Report');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates outDir if it does not exist', () => {
    const tmpDir = path.join(os.tmpdir(), `portfolio-mkdir-test-${Date.now()}`, 'nested', 'deep');
    const portfolio = makePortfolio([]);

    writePortfolioReport(portfolio, tmpDir);
    expect(fs.existsSync(tmpDir)).toBe(true);

    fs.rmSync(path.join(os.tmpdir(), `portfolio-mkdir-test-${Date.now() - 10}`), { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
