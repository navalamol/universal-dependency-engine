'use strict';

const { classifyExposure, classifyPlanExposure } = require('../../src/core/exposure-classifier');
const { EXPOSURE } = require('../../src/core/evidence-model');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeItem(name, overrides = {}) {
  return {
    libraryName:    name,
    currentVersion: '1.0.0',
    phase:          'A',
    upgradeType:    'SAFE',
    rootParents:    [],
    depChain:       [],
    ...overrides,
  };
}

function makeDepTree(entries) {
  // entries: { [name]: [{ dev, parents }] }
  const m = new Map();
  for (const [name, arr] of Object.entries(entries)) {
    m.set(name, arr);
  }
  return m;
}

// ─── No dep-tree ─────────────────────────────────────────────────────────────

test('no depTree returns UNKNOWN_EXPOSURE confidence=0', () => {
  const result = classifyExposure(makeItem('lodash'), null);
  expect(result.classification).toBe(EXPOSURE.UNKNOWN_EXPOSURE);
  expect(result.confidence).toBe(0);
  expect(result.evidenceSources).toContain('no-dep-tree');
});

test('depTree is not a Map returns UNKNOWN_EXPOSURE', () => {
  const result = classifyExposure(makeItem('lodash'), {});
  expect(result.classification).toBe(EXPOSURE.UNKNOWN_EXPOSURE);
});

test('package not in depTree returns UNKNOWN_EXPOSURE confidence=0.1', () => {
  const tree = makeDepTree({ 'axios': [{ dev: false, parents: [] }] });
  const result = classifyExposure(makeItem('lodash'), tree);
  expect(result.classification).toBe(EXPOSURE.UNKNOWN_EXPOSURE);
  expect(result.confidence).toBe(0.1);
  expect(result.evidenceSources).toContain('package-not-in-lock-tree');
});

// ─── Production path detection ────────────────────────────────────────────────

test('non-dev direct dep → RUNTIME_REACHABLE', () => {
  const tree = makeDepTree({ lodash: [{ dev: false, parents: [] }] });
  const item = makeItem('lodash', { depChain: ['lodash'] });
  const result = classifyExposure(item, tree);
  expect(result.classification).toBe(EXPOSURE.RUNTIME_REACHABLE);
  expect(result.confidence).toBeGreaterThan(0.8);
  expect(result.evidenceSources).toContain('lock-file: non-dev entry');
});

test('non-dev direct dep (empty depChain) → RUNTIME_REACHABLE', () => {
  const tree = makeDepTree({ lodash: [{ dev: false, parents: [] }] });
  const item = makeItem('lodash', { depChain: [] });
  const result = classifyExposure(item, tree);
  expect(result.classification).toBe(EXPOSURE.RUNTIME_REACHABLE);
});

test('non-dev transitive dep (depth>1) → PRODUCTION_BUNDLED', () => {
  const tree = makeDepTree({ lodash: [{ dev: false, parents: [{ name: 'react', range: '^17' }] }] });
  const item = makeItem('lodash', { depChain: ['react', 'lodash'] });
  const result = classifyExposure(item, tree);
  expect(result.classification).toBe(EXPOSURE.PRODUCTION_BUNDLED);
  expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  expect(result.evidenceSources.some(s => s.includes('transitive'))).toBe(true);
});

test('non-dev root parent boosts evidence sources', () => {
  const tree = makeDepTree({ lodash: [{ dev: false, parents: [] }] });
  const item = makeItem('lodash', {
    depChain: ['lodash'],
    rootParents: [{ name: 'react', range: '^17', isDev: false }],
  });
  const result = classifyExposure(item, tree);
  expect(result.evidenceSources).toContain('root-parent: isDev=false');
});

test('entry with dev=null treated as production', () => {
  const tree = makeDepTree({ lodash: [{ dev: null, parents: [] }] });
  const item = makeItem('lodash', { depChain: ['lodash'] });
  const result = classifyExposure(item, tree);
  expect(result.classification).toBe(EXPOSURE.RUNTIME_REACHABLE);
});

// ─── Dev classification ───────────────────────────────────────────────────────

test('all-dev + test framework name → TEST_ONLY', () => {
  const tree = makeDepTree({ jest: [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('jest'), tree);
  expect(result.classification).toBe(EXPOSURE.TEST_ONLY);
  expect(result.evidenceSources).toContain('package-name: matches test-framework pattern');
});

test('all-dev + jest-scoped package → TEST_ONLY', () => {
  const tree = makeDepTree({ '@jest/core': [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('@jest/core'), tree);
  expect(result.classification).toBe(EXPOSURE.TEST_ONLY);
});

test('all-dev + mocha → TEST_ONLY', () => {
  const tree = makeDepTree({ mocha: [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('mocha'), tree);
  expect(result.classification).toBe(EXPOSURE.TEST_ONLY);
});

test('all-dev + webpack → BUILD_TIME_EXECUTED', () => {
  const tree = makeDepTree({ webpack: [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('webpack'), tree);
  expect(result.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
  expect(result.evidenceSources).toContain('package-name: matches build-tool pattern');
});

test('all-dev + babel → BUILD_TIME_EXECUTED', () => {
  const tree = makeDepTree({ '@babel/core': [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('@babel/core'), tree);
  expect(result.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
});

test('all-dev + typescript → BUILD_TIME_EXECUTED', () => {
  const tree = makeDepTree({ typescript: [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('typescript'), tree);
  expect(result.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
});

test('all-dev + eslint → BUILD_TIME_EXECUTED', () => {
  const tree = makeDepTree({ eslint: [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('eslint'), tree);
  expect(result.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
});

test('all-dev + cross-env → CI_EXECUTED', () => {
  const tree = makeDepTree({ 'cross-env': [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('cross-env'), tree);
  expect(result.classification).toBe(EXPOSURE.CI_EXECUTED);
  expect(result.evidenceSources).toContain('package-name: matches CI-tool pattern');
});

test('all-dev + unknown package → LOCAL_TOOLING_ONLY', () => {
  const tree = makeDepTree({ 'some-random-tool': [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('some-random-tool'), tree);
  expect(result.classification).toBe(EXPOSURE.LOCAL_TOOLING_ONLY);
  expect(result.confidence).toBeGreaterThanOrEqual(0.5);
});

// ─── RULE: devDependency flag alone does NOT make it safe ────────────────────

test('dev=true but unknown package stays in LOCAL_TOOLING_ONLY, not "safe"', () => {
  // The classification is LOCAL_TOOLING_ONLY, NOT "not critical" —
  // callers must still handle the CVE severity.
  const tree = makeDepTree({ 'mystery-cli': [{ dev: true, parents: [] }] });
  const result = classifyExposure(makeItem('mystery-cli'), tree);
  expect(result.classification).toBe(EXPOSURE.LOCAL_TOOLING_ONLY);
  // Confidence is below 1.0 — uncertainty is preserved
  expect(result.confidence).toBeLessThan(1.0);
});

// ─── package.json scripts scanning ───────────────────────────────────────────

test('packageJson scripts: package in test script → TEST_ONLY even without name pattern', () => {
  const tree = makeDepTree({ 'my-special-reporter': [{ dev: true, parents: [] }] });
  const packageJson = {
    scripts: { test: 'my-special-reporter --coverage' },
  };
  const result = classifyExposure(makeItem('my-special-reporter'), tree, { packageJson });
  expect(result.classification).toBe(EXPOSURE.TEST_ONLY);
  expect(result.evidenceSources.some(s => s.includes('lifecycle-scripts'))).toBe(true);
});

test('packageJson scripts: package in build script → BUILD_TIME_EXECUTED', () => {
  const tree = makeDepTree({ 'custom-bundler': [{ dev: true, parents: [] }] });
  const packageJson = {
    scripts: { build: 'custom-bundler src/index.js' },
  };
  const result = classifyExposure(makeItem('custom-bundler'), tree, { packageJson });
  expect(result.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
});

test('packageJson scripts: package in lint script → CI_EXECUTED', () => {
  const tree = makeDepTree({ 'custom-linter': [{ dev: true, parents: [] }] });
  const packageJson = {
    scripts: { lint: 'custom-linter .' },
  };
  const result = classifyExposure(makeItem('custom-linter'), tree, { packageJson });
  expect(result.classification).toBe(EXPOSURE.CI_EXECUTED);
});

test('packageJson scripts: package not in any script → falls through to LOCAL_TOOLING_ONLY', () => {
  const tree = makeDepTree({ 'something-unlisted': [{ dev: true, parents: [] }] });
  const packageJson = { scripts: { test: 'jest' } };
  const result = classifyExposure(makeItem('something-unlisted'), tree, { packageJson });
  expect(result.classification).toBe(EXPOSURE.LOCAL_TOOLING_ONLY);
});

// ─── Mixed dev/prod entries ───────────────────────────────────────────────────

test('package with both dev and prod entries classified as production (anyProd wins)', () => {
  // Same package installed as both direct dep and as a transitive dev dep
  const tree = makeDepTree({
    lodash: [
      { dev: false, parents: [] },
      { dev: true,  parents: [{ name: 'some-dev-tool', range: '*' }] },
    ],
  });
  const item = makeItem('lodash', { depChain: ['lodash'] });
  const result = classifyExposure(item, tree);
  expect(result.classification).toBe(EXPOSURE.RUNTIME_REACHABLE);
});

// ─── classifyPlanExposure ─────────────────────────────────────────────────────

test('classifyPlanExposure returns one result per item', () => {
  const tree = makeDepTree({
    lodash:  [{ dev: false, parents: [] }],
    webpack: [{ dev: true,  parents: [] }],
  });
  const plan = [
    makeItem('lodash',  { depChain: ['lodash'] }),
    makeItem('webpack', { depChain: ['webpack'] }),
  ];
  const results = classifyPlanExposure(plan, tree);
  expect(results).toHaveLength(2);
  expect(results[0].item.libraryName).toBe('lodash');
  expect(results[0].exposureResult.classification).toBe(EXPOSURE.RUNTIME_REACHABLE);
  expect(results[1].exposureResult.classification).toBe(EXPOSURE.BUILD_TIME_EXECUTED);
});

test('classifyPlanExposure with empty plan returns empty array', () => {
  expect(classifyPlanExposure([], null)).toEqual([]);
});

test('classifyPlanExposure with null plan returns empty array', () => {
  expect(classifyPlanExposure(null, null)).toEqual([]);
});

// ─── evidenceSources are always non-empty strings ────────────────────────────

test('every classification returns at least one evidence source', () => {
  const tree = makeDepTree({ lodash: [{ dev: false, parents: [] }] });
  const result = classifyExposure(makeItem('lodash', { depChain: ['lodash'] }), tree);
  expect(result.evidenceSources.length).toBeGreaterThan(0);
  expect(result.evidenceSources.every(s => typeof s === 'string' && s.length > 0)).toBe(true);
});

// ─── Confidence bounds ────────────────────────────────────────────────────────

test('confidence is always a number between 0 and 1 inclusive', () => {
  const cases = [
    { name: 'lodash',  tree: { lodash: [{ dev: false, parents: [] }] }, chain: ['lodash'] },
    { name: 'jest',    tree: { jest:   [{ dev: true,  parents: [] }] }, chain: [] },
    { name: 'webpack', tree: { webpack:[{ dev: true,  parents: [] }] }, chain: [] },
    { name: 'unknown', tree: { unknown:[{ dev: true,  parents: [] }] }, chain: [] },
  ];
  for (const c of cases) {
    const t   = makeDepTree(c.tree);
    const res = classifyExposure(makeItem(c.name, { depChain: c.chain }), t);
    expect(res.confidence).toBeGreaterThanOrEqual(0);
    expect(res.confidence).toBeLessThanOrEqual(1);
  }
});
