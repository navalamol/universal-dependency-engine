'use strict';

const { buildPaths, rankPaths, comparePaths, enrichWithPaths, LABELS, BUDGET_TIERS } = require('../../src/core/remediation-paths');

function makeItem(overrides) {
  return {
    libraryName:       'test-pkg',
    currentVersion:    '1.2.0',
    recommendedVersion: '1.4.0',
    upgradeType:       'SAFE',
    phase:             'A',
    cves:              [{ id: 'CVE-001' }],
    ...overrides,
  };
}

// ── buildPaths ───────────────────────────────────────────────────────────────

describe('buildPaths', () => {
  test('Phase A SAFE → single DIRECT_OVERRIDE path, SAFE_ALIGNED', () => {
    const paths = buildPaths(makeItem());
    expect(paths).toHaveLength(1);
    expect(paths[0].type).toBe('DIRECT_OVERRIDE');
    expect(paths[0].decisionLabel).toBe(LABELS.SAFE_ALIGNED);
    expect(paths[0].budgetTier).toBe(BUDGET_TIERS.SINGLE_OVERRIDE);
    expect(paths[0].confidence).toBe('INFERRED');
  });

  test('Phase B SAFE → DIRECT_OVERRIDE, CONTROLLED_OVERRIDE', () => {
    const paths = buildPaths(makeItem({ phase: 'B' }));
    expect(paths[0].type).toBe('DIRECT_OVERRIDE');
    expect(paths[0].decisionLabel).toBe(LABELS.CONTROLLED_OVERRIDE);
  });

  test('MAJOR_BUMP with parentUpgradePaths → PARENT_UPGRADE first + DIRECT_OVERRIDE fallback', () => {
    const item = makeItem({
      upgradeType: 'MAJOR_BUMP',
      currentVersion: '3.3.0',
      recommendedVersion: '5.0.0',
      phase: 'B',
      parentUpgradePaths: [{
        parent:               'my-app',
        parentAllowedRange:   '^2.0.0',
        parentUpgradeVersion: '2.3.0',
        childDeclaredRange:   '^5.0.0',
        childFixVersion:      '5.0.0',
        chainVia:             [],
        isDev:                false,
        manifestVerified:     true,
        simulationVerified:   false,
      }],
    });
    const paths = buildPaths(item);
    expect(paths).toHaveLength(2);
    const parentPath = paths.find(p => p.type === 'PARENT_UPGRADE');
    const overridePath = paths.find(p => p.type === 'DIRECT_OVERRIDE');
    expect(parentPath).toBeDefined();
    expect(parentPath.decisionLabel).toBe(LABELS.SAFE_PARENT_UPGRADE);
    expect(parentPath.confidence).toBe('INFERRED'); // manifestVerified but not simulationVerified
    expect(overridePath).toBeDefined();
    expect(overridePath.decisionLabel).toBe(LABELS.CONTROLLED_OVERRIDE);
  });

  test('simulationVerified path gets VERIFIED confidence', () => {
    const item = makeItem({
      upgradeType: 'MAJOR_BUMP',
      phase: 'B',
      parentUpgradePaths: [{
        parent: 'root', parentAllowedRange: '^1.0.0', parentUpgradeVersion: '1.5.0',
        childDeclaredRange: '^5.0.0', childFixVersion: '5.0.0', chainVia: [],
        isDev: false, manifestVerified: true, simulationVerified: true,
      }],
    });
    const paths = buildPaths(item);
    const p = paths.find(p => p.type === 'PARENT_UPGRADE');
    expect(p.confidence).toBe('VERIFIED');
  });

  test('NO_FIX → NOT_FIXABLE path', () => {
    const paths = buildPaths(makeItem({ upgradeType: 'NO_FIX', recommendedVersion: undefined }));
    expect(paths).toHaveLength(1);
    expect(paths[0].type).toBe('NO_FIX');
    expect(paths[0].decisionLabel).toBe(LABELS.NOT_FIXABLE);
  });

  test('NO_FIX + probableFalsePositive → NON_RUNTIME_EXPOSURE', () => {
    const paths = buildPaths(makeItem({ upgradeType: 'NO_FIX', recommendedVersion: undefined, probableFalsePositive: true }));
    expect(paths[0].decisionLabel).toBe(LABELS.NON_RUNTIME_EXPOSURE);
  });

  test('nested override item → NESTED_OVERRIDE type', () => {
    const item = makeItem({
      phase: 'B',
      nestedOverrides: { 'parent-a': { 'test-pkg': '1.4.0' } },
    });
    const paths = buildPaths(item);
    expect(paths.some(p => p.type === 'NESTED_OVERRIDE')).toBe(true);
  });
});

// ── rankPaths ────────────────────────────────────────────────────────────────

describe('rankPaths', () => {
  test('VERIFIED beats INFERRED beats MANUAL', () => {
    const paths = [
      { type: 'X', confidence: 'MANUAL',   budgetTier: 1, semverDist: 0, decisionLabel: '' },
      { type: 'Y', confidence: 'VERIFIED', budgetTier: 6, semverDist: 0, decisionLabel: '' },
      { type: 'Z', confidence: 'INFERRED', budgetTier: 1, semverDist: 0, decisionLabel: '' },
    ];
    const ranked = rankPaths(paths);
    expect(ranked[0].confidence).toBe('VERIFIED');
    expect(ranked[1].confidence).toBe('INFERRED');
    expect(ranked[2].confidence).toBe('MANUAL');
  });

  test('same confidence: lower budgetTier wins', () => {
    const paths = [
      { type: 'override', confidence: 'INFERRED', budgetTier: 6, semverDist: 0, decisionLabel: '' },
      { type: 'parent',   confidence: 'INFERRED', budgetTier: 4, semverDist: 0, decisionLabel: '' },
    ];
    const ranked = rankPaths(paths);
    expect(ranked[0].budgetTier).toBe(4);
  });

  test('same confidence + tier: lower semverDist wins', () => {
    const paths = [
      { confidence: 'INFERRED', budgetTier: 6, semverDist: 200, decisionLabel: '' },
      { confidence: 'INFERRED', budgetTier: 6, semverDist:  50, decisionLabel: '' },
    ];
    const ranked = rankPaths(paths);
    expect(ranked[0].semverDist).toBe(50);
  });
});

// ── comparePaths ─────────────────────────────────────────────────────────────

describe('comparePaths', () => {
  test('Phase A SAFE → SAFE_ALIGNED decisionLabel, no alternativePaths', () => {
    const result = comparePaths(makeItem());
    expect(result.decisionLabel).toBe(LABELS.SAFE_ALIGNED);
    expect(result.recommendedPath).not.toBeNull();
    expect(result.alternativePaths).toHaveLength(0);
  });

  test('MAJOR_BUMP with no parentUpgradePaths → MANUAL_SECURITY_REVIEW', () => {
    const result = comparePaths(makeItem({ upgradeType: 'MAJOR_BUMP', phase: 'C' }));
    expect(result.decisionLabel).toBe(LABELS.MANUAL_SECURITY_REVIEW);
  });

  test('MAJOR_BUMP with VERIFIED parent path → SAFE_PARENT_UPGRADE recommended, override as alternative', () => {
    const item = makeItem({
      upgradeType: 'MAJOR_BUMP',
      phase: 'B',
      parentUpgradePaths: [{
        parent: 'root', parentAllowedRange: '^1.0.0', parentUpgradeVersion: '1.5.0',
        childDeclaredRange: '^5.0.0', childFixVersion: '5.0.0', chainVia: [],
        isDev: false, manifestVerified: true, simulationVerified: true,
      }],
    });
    const result = comparePaths(item);
    expect(result.decisionLabel).toBe(LABELS.SAFE_PARENT_UPGRADE);
    expect(result.recommendedPath.type).toBe('PARENT_UPGRADE');
    expect(result.recommendedPath.confidence).toBe('VERIFIED');
    expect(result.alternativePaths).toHaveLength(1);
    expect(result.alternativePaths[0].type).toBe('DIRECT_OVERRIDE');
  });

  test('NO_FIX → NOT_FIXABLE', () => {
    const result = comparePaths(makeItem({ upgradeType: 'NO_FIX', recommendedVersion: undefined }));
    expect(result.decisionLabel).toBe(LABELS.NOT_FIXABLE);
  });
});

// ── enrichWithPaths ───────────────────────────────────────────────────────────

describe('enrichWithPaths', () => {
  test('maps every item — all get recommendedPath + alternativePaths + decisionLabel', () => {
    const plan = [
      makeItem({ phase: 'A' }),
      makeItem({ upgradeType: 'NO_FIX', recommendedVersion: undefined }),
      makeItem({ upgradeType: 'MAJOR_BUMP', phase: 'C' }),
    ];
    const result = enrichWithPaths(plan);
    for (const item of result) {
      expect(item).toHaveProperty('recommendedPath');
      expect(item).toHaveProperty('alternativePaths');
      expect(item).toHaveProperty('decisionLabel');
      expect(typeof item.decisionLabel).toBe('string');
    }
  });

  test('original plan items are not mutated', () => {
    const plan = [makeItem()];
    enrichWithPaths(plan);
    expect(plan[0]).not.toHaveProperty('decisionLabel');
  });
});
