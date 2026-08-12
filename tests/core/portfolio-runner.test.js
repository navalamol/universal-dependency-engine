'use strict';

// ---------------------------------------------------------------------------
// Mocks — declared before any require so Jest intercepts the module cache
// ---------------------------------------------------------------------------

jest.mock('../../src/providers/index', () => ({
  detectProvider: jest.fn(),
  getParser:      jest.fn(),
  PROVIDER_NAMES: ['mend', 'snyk', 'npm-audit'],
}));
jest.mock('../../src/core/semver-engine',      () => ({ buildResolutionPlan:  jest.fn() }));
jest.mock('../../src/core/phases',             () => ({ applyPhases:          jest.fn(), PHASE_META: { A: {}, B: {}, C: {} } }));
jest.mock('../../src/core/confidence',         () => ({ enrichWithConfidence: jest.fn() }));
jest.mock('../../src/core/remediation-paths',  () => ({ enrichWithPaths:      jest.fn() }));
jest.mock('../../src/ecosystems/index',        () => ({ detectEcosystem:      jest.fn() }));
jest.mock('../../src/ecosystems/npm/lock-parser', () => ({
  parseLockFile: jest.fn(),
  getRootDeps:   jest.fn(),
}));
jest.mock('../../src/ecosystems/npm/registry',    () => ({ verifyPlanVersions: jest.fn() }));
jest.mock('../../src/ecosystems/maven/registry',  () => ({ verifyPlanVersions: jest.fn() }));
jest.mock('../../src/ecosystems/python/registry', () => ({ verifyPlanVersions: jest.fn() }));
jest.mock('../../src/ecosystems/go/registry',     () => ({ verifyPlanVersions: jest.fn() }));
jest.mock('../../src/ecosystems/dotnet/registry', () => ({ verifyPlanVersions: jest.fn() }));
jest.mock('../../src/ecosystems/rust/registry',   () => ({ verifyPlanVersions: jest.fn() }));

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { detectProvider, getParser }    = require('../../src/providers/index');
const { buildResolutionPlan }          = require('../../src/core/semver-engine');
const { applyPhases }                  = require('../../src/core/phases');
const { enrichWithConfidence }         = require('../../src/core/confidence');
const { enrichWithPaths }              = require('../../src/core/remediation-paths');
const { detectEcosystem }              = require('../../src/ecosystems/index');
const { verifyPlanVersions: verifyNpm } = require('../../src/ecosystems/npm/registry');

const { loadConfig, analyzeRepo, runPortfolio } = require('../../portfolio-runner');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhasedItems(phaseACount = 2, phaseBCount = 1, phaseCCount = 1) {
  const items = [];
  for (let i = 0; i < phaseACount; i++) {
    items.push({
      libraryName:       `pkg-a-${i}`,
      currentVersion:    '1.0.0',
      recommendedVersion: '1.0.1',
      phase:  'A',
      upgradeType: 'SAFE',
      cves:   [{ id: `CVE-2024-A${i}`, severity: 'HIGH', score: 7.5 }],
    });
  }
  for (let i = 0; i < phaseBCount; i++) {
    items.push({
      libraryName:       `pkg-b-${i}`,
      currentVersion:    '2.0.0',
      recommendedVersion: '2.1.0',
      phase:  'B',
      upgradeType: 'SAFE',
      cves:   [{ id: `CVE-2024-B${i}`, severity: 'MEDIUM', score: 5.0 }],
    });
  }
  for (let i = 0; i < phaseCCount; i++) {
    items.push({
      libraryName:       `pkg-c-${i}`,
      currentVersion:    '3.0.0',
      recommendedVersion: null,
      phase:  'C',
      upgradeType: 'NO_FIX',
      cves:   [{ id: `CVE-2024-C${i}`, severity: 'CRITICAL', score: 9.8 }],
    });
  }
  return items;
}

function makeTempConfig(data) {
  const tmpPath = path.join(os.tmpdir(), `portfolio-test-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  return tmpPath;
}

function setupHappyPath(phasedItems) {
  const entries = [
    { libraryName: 'pkg', cves: [{ id: 'CVE-1', severity: 'HIGH', score: 7 }] },
  ];
  detectProvider.mockReturnValue('snyk');
  getParser.mockReturnValue({ parseReport: () => entries });
  detectEcosystem.mockReturnValue('npm');
  buildResolutionPlan.mockReturnValue([]);
  applyPhases.mockReturnValue(phasedItems);
  enrichWithConfidence.mockReturnValue(phasedItems);
  enrichWithPaths.mockReturnValue(phasedItems);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('parses valid config with repos array', () => {
    const cfg = makeTempConfig({ repos: [{ name: 'my-repo', report: './report.json' }] });
    const result = loadConfig(cfg);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe('my-repo');
  });

  test('throws when repos is missing', () => {
    const cfg = makeTempConfig({ noRepos: [] });
    expect(() => loadConfig(cfg)).toThrow('Portfolio config must have a "repos" array');
  });

  test('throws when repos is not an array', () => {
    const cfg = makeTempConfig({ repos: 'not-an-array' });
    expect(() => loadConfig(cfg)).toThrow('"repos" array');
  });

  test('throws when a repo entry is missing name', () => {
    const cfg = makeTempConfig({ repos: [{ report: './report.json' }] });
    expect(() => loadConfig(cfg)).toThrow('"name" field');
  });

  test('throws when a repo entry is missing report', () => {
    const cfg = makeTempConfig({ repos: [{ name: 'repo-1' }] });
    expect(() => loadConfig(cfg)).toThrow('"report" field');
  });

  test('throws on invalid JSON', () => {
    const tmpPath = path.join(os.tmpdir(), `portfolio-bad-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, '{ not valid json }');
    expect(() => loadConfig(tmpPath)).toThrow('Invalid JSON');
  });
});

// ---------------------------------------------------------------------------
// analyzeRepo
// ---------------------------------------------------------------------------

describe('analyzeRepo', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns ok status and correct shape on success', async () => {
    const phasedItems = makePhasedItems(2, 1, 1);
    setupHappyPath(phasedItems);

    const result = await analyzeRepo({ name: 'my-repo', report: './report.json' });

    expect(result.status).toBe('ok');
    expect(result.name).toBe('my-repo');
    expect(result.ecosystem).toBe('npm');
    expect(result.provider).toBe('snyk');
    expect(result.phaseA).toHaveLength(2);
    expect(result.phaseB).toHaveLength(1);
    expect(result.phaseC).toHaveLength(1);
  });

  test('auto-detects provider when not specified', async () => {
    const phasedItems = makePhasedItems(1, 0, 0);
    setupHappyPath(phasedItems);

    await analyzeRepo({ name: 'repo', report: './r.json' });
    expect(detectProvider).toHaveBeenCalledWith('./r.json');
  });

  test('uses forced provider from repoEntry', async () => {
    const phasedItems = makePhasedItems(1, 0, 0);
    setupHappyPath(phasedItems);

    await analyzeRepo({ name: 'repo', report: './r.json', provider: 'mend' });
    expect(detectProvider).not.toHaveBeenCalled();
    expect(getParser).toHaveBeenCalledWith('mend');
  });

  test('sets status=error on parse failure', async () => {
    detectProvider.mockReturnValue('mend');
    getParser.mockReturnValue({ parseReport: () => { throw new Error('file not found'); } });

    const result = await analyzeRepo({ name: 'bad-repo', report: './missing.json' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('file not found');
    expect(result.phaseA).toHaveLength(0);
  });

  test('aggregates totalCves from all entries', async () => {
    const entries = [
      { libraryName: 'a', cves: [{ id: 'CVE-1' }, { id: 'CVE-2' }] },
      { libraryName: 'b', cves: [{ id: 'CVE-3' }] },
    ];
    detectProvider.mockReturnValue('snyk');
    getParser.mockReturnValue({ parseReport: () => entries });
    detectEcosystem.mockReturnValue('npm');
    buildResolutionPlan.mockReturnValue([]);
    const phasedItems = makePhasedItems(0, 0, 0);
    applyPhases.mockReturnValue(phasedItems);
    enrichWithConfidence.mockReturnValue(phasedItems);
    enrichWithPaths.mockReturnValue(phasedItems);

    const result = await analyzeRepo({ name: 'r', report: './r.json' });
    expect(result.totalLibraries).toBe(2);
    expect(result.totalCves).toBe(3);
  });

  test('counts severity from item CVEs', async () => {
    const phasedItems = [
      { phase: 'A', libraryName: 'a', currentVersion: '1.0', recommendedVersion: '1.1', upgradeType: 'SAFE',
        cves: [{ id: 'C1', severity: 'CRITICAL', score: 9.8 }, { id: 'C2', severity: 'HIGH', score: 7 }] },
      { phase: 'B', libraryName: 'b', currentVersion: '2.0', recommendedVersion: '2.1', upgradeType: 'SAFE',
        cves: [{ id: 'C3', severity: 'MEDIUM', score: 5 }] },
    ];
    setupHappyPath(phasedItems);

    const result = await analyzeRepo({ name: 'r', report: './r.json' });
    expect(result.criticalCount).toBe(1);
    expect(result.highCount).toBe(1);
    expect(result.mediumCount).toBe(1);
    expect(result.lowCount).toBe(0);
  });

  test('highestSeverity = CRITICAL when critical exists', async () => {
    const phasedItems = [
      { phase: 'A', libraryName: 'a', currentVersion: '1.0', recommendedVersion: '1.1', upgradeType: 'SAFE',
        cves: [{ id: 'C1', severity: 'CRITICAL', score: 9.8 }, { id: 'C2', severity: 'HIGH', score: 7 }] },
    ];
    setupHappyPath(phasedItems);
    const result = await analyzeRepo({ name: 'r', report: './r.json' });
    expect(result.highestSeverity).toBe('CRITICAL');
  });

  test('highestSeverity = HIGH when only high exists', async () => {
    const phasedItems = [
      { phase: 'A', libraryName: 'a', currentVersion: '1.0', recommendedVersion: '1.1', upgradeType: 'SAFE',
        cves: [{ id: 'C1', severity: 'HIGH', score: 7 }] },
    ];
    setupHappyPath(phasedItems);
    const result = await analyzeRepo({ name: 'r', report: './r.json' });
    expect(result.highestSeverity).toBe('HIGH');
  });

  test('highestSeverity = NONE when no CVEs on items', async () => {
    const phasedItems = [];
    setupHappyPath(phasedItems);
    const result = await analyzeRepo({ name: 'r', report: './r.json' });
    expect(result.highestSeverity).toBe('NONE');
  });

  test('calls verifyPlanVersions when verifyVersions=true', async () => {
    const phasedItems = makePhasedItems(1, 0, 0);
    setupHappyPath(phasedItems);
    verifyNpm.mockResolvedValue([]);

    await analyzeRepo({ name: 'r', report: './r.json' }, { verifyVersions: true });
    expect(verifyNpm).toHaveBeenCalled();
  });

  test('skips verifyPlanVersions when verifyVersions=false', async () => {
    const phasedItems = makePhasedItems(1, 0, 0);
    setupHappyPath(phasedItems);

    await analyzeRepo({ name: 'r', report: './r.json' }, { verifyVersions: false });
    expect(verifyNpm).not.toHaveBeenCalled();
  });

  test('per-repo verifyVersions overrides global', async () => {
    const phasedItems = makePhasedItems(1, 0, 0);
    setupHappyPath(phasedItems);
    verifyNpm.mockResolvedValue([]);

    await analyzeRepo({ name: 'r', report: './r.json', verifyVersions: true }, { verifyVersions: false });
    expect(verifyNpm).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runPortfolio
// ---------------------------------------------------------------------------

describe('runPortfolio', () => {
  beforeEach(() => jest.clearAllMocks());

  function setupTwoRepos() {
    const phasedA = makePhasedItems(2, 1, 0);
    const phasedB = makePhasedItems(0, 0, 1);
    let call = 0;
    detectProvider.mockReturnValue('snyk');
    detectEcosystem.mockReturnValue('npm');
    buildResolutionPlan.mockReturnValue([]);
    applyPhases.mockImplementation(() => call++ === 0 ? phasedA : phasedB);
    enrichWithConfidence.mockImplementation((p) => p);
    enrichWithPaths.mockImplementation((p) => p);
    getParser.mockReturnValue({ parseReport: () => [{ libraryName: 'x', cves: [{ id: 'C1', severity: 'HIGH', score: 7 }] }] });
    return { phasedA, phasedB };
  }

  test('aggregates totalPhaseA/B/C across repos', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({
      repos: [
        { name: 'repo-1', report: './r1.json' },
        { name: 'repo-2', report: './r2.json' },
      ],
    });
    const result = await runPortfolio(cfg);
    expect(result.totalRepos).toBe(2);
    expect(result.totalPhaseA).toBe(2);
    expect(result.totalPhaseB).toBe(1);
    expect(result.totalPhaseC).toBe(1);
  });

  test('errorCount counts failed repos', async () => {
    detectProvider.mockReturnValue('mend');
    getParser.mockReturnValueOnce({ parseReport: () => { throw new Error('oops'); } });
    detectEcosystem.mockReturnValue('npm');
    buildResolutionPlan.mockReturnValue([]);
    applyPhases.mockReturnValue([]);
    enrichWithConfidence.mockReturnValue([]);
    enrichWithPaths.mockReturnValue([]);
    getParser.mockReturnValue({ parseReport: () => [] });

    const cfg = makeTempConfig({
      repos: [
        { name: 'bad-repo', report: './bad.json' },
        { name: 'good-repo', report: './good.json' },
      ],
    });
    const result = await runPortfolio(cfg);
    expect(result.errorCount).toBe(1);
    expect(result.repos[0].status).toBe('error');
    expect(result.repos[1].status).toBe('ok');
  });

  test('outDir defaults to portfolio-output next to config', async () => {
    setupTwoRepos();
    const tmpDir = os.tmpdir();
    const cfg = makeTempConfig({ repos: [{ name: 'r', report: './r.json' }] });

    const result = await runPortfolio(cfg);
    expect(result.outDir).toBe(path.join(tmpDir, 'portfolio-output'));
  });

  test('outDir from opts overrides config default', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({ repos: [{ name: 'r', report: './r.json' }] });
    const custom = path.join(os.tmpdir(), 'my-portfolio');

    const result = await runPortfolio(cfg, { outDir: custom });
    expect(result.outDir).toBe(custom);
  });

  test('outDir from config overrides default', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({ repos: [{ name: 'r', report: './r.json' }], outDir: '/custom/out' });

    const result = await runPortfolio(cfg);
    expect(result.outDir).toBe('/custom/out');
  });

  test('repo outDir is sanitized name under portfolio outDir', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({ repos: [{ name: 'org/my-repo', report: './r.json' }] });

    const result = await runPortfolio(cfg);
    expect(result.repos[0].outDir).toContain('org_my-repo');
  });

  test('totalCves and totalLibraries aggregate across repos', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({
      repos: [
        { name: 'r1', report: './r1.json' },
        { name: 'r2', report: './r2.json' },
      ],
    });
    const result = await runPortfolio(cfg);
    expect(result.totalCves).toBe(2);
    expect(result.totalLibraries).toBe(2);
  });

  test('runDate is set to today', async () => {
    setupTwoRepos();
    const cfg = makeTempConfig({ repos: [{ name: 'r', report: './r.json' }] });
    const today = new Date().toISOString().split('T')[0];

    const result = await runPortfolio(cfg);
    expect(result.runDate).toBe(today);
  });
});
