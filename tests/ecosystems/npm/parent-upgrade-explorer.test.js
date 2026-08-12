'use strict';

jest.mock('../../../src/ecosystems/npm/registry', () => ({
  getPublishedVersions: jest.fn(),
  getManifest:          jest.fn(),
}));

jest.mock('../../../src/ecosystems/npm/simulator', () => ({
  simulate: jest.fn(),
}));

jest.mock('../../../src/core/security-delta', () => ({
  computeSecurityDelta: jest.fn().mockReturnValue({ fixed: [], introduced: [] }),
}));

const {
  recursiveResolveChainChildRange,
  findParentUpgradePaths,
  exploreParentUpgrades,
} = require('../../../src/ecosystems/npm/parent-upgrade-explorer');

const { getPublishedVersions, getManifest } = require('../../../src/ecosystems/npm/registry');
const { simulate } = require('../../../src/ecosystems/npm/simulator');

// Helper: default ctx for direct tests of recursiveResolveChainChildRange
function ctx(overrides) {
  return { visited: new Set(), depth: 0, maxDepth: 5, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── recursiveResolveChainChildRange ──────────────────────────────────────────

describe('recursiveResolveChainChildRange — base cases (empty chain)', () => {
  test('direct parent declares covering range → returned', async () => {
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });

    const range = await recursiveResolveChainChildRange(
      'parent', '1.5.0', [], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBe('^2.0.0');
  });

  test('direct parent declares range in peerDependencies → returned', async () => {
    getManifest.mockResolvedValueOnce({
      dependencies: {},
      peerDependencies: { 'vulnerable-pkg': '>=2.0.0' },
    });

    const range = await recursiveResolveChainChildRange(
      'parent', '1.5.0', [], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBe('>=2.0.0');
  });

  test('direct parent declares range that does NOT cover fix → null', async () => {
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^1.0.0' }, // does not cover 2.0.0
      peerDependencies: {},
    });

    const range = await recursiveResolveChainChildRange(
      'parent', '1.5.0', [], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
  });

  test('child not in manifest → null', async () => {
    getManifest.mockResolvedValueOnce({
      dependencies: { other: '^1.0.0' },
      peerDependencies: {},
    });

    const range = await recursiveResolveChainChildRange(
      'parent', '1.5.0', [], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
  });

  test('manifest fetch fails → null', async () => {
    getManifest.mockResolvedValueOnce(null);

    const range = await recursiveResolveChainChildRange(
      'parent', '1.5.0', [], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
  });
});

describe('recursiveResolveChainChildRange — guardrails', () => {
  test('depth limit: returns null when depth >= maxDepth', async () => {
    const range = await recursiveResolveChainChildRange(
      'pkg', '1.0.0', ['intermediate'], 'child', '2.0.0',
      ctx({ depth: 5, maxDepth: 5 })
    );
    expect(range).toBeNull();
    expect(getManifest).not.toHaveBeenCalled();
  });

  test('cycle detection: skips pkg@version already on this branch', async () => {
    // If 'intermediate@1.0.0' is already in visited, it must be skipped
    getManifest.mockResolvedValueOnce({
      dependencies: { intermediate: '^1.0.0' },
      peerDependencies: {},
    });
    getPublishedVersions.mockResolvedValueOnce(['1.0.0']);

    const range = await recursiveResolveChainChildRange(
      'parent', '1.0.0', ['intermediate'], 'child', '2.0.0',
      ctx({ visited: new Set(['intermediate@1.0.0']) })
    );
    // intermediate@1.0.0 is in visited → cycle → all candidates skipped → null
    expect(range).toBeNull();
  });

  test('candidate limit: inspects at most CANDIDATE_LIMIT (10) versions per level', async () => {
    getManifest.mockImplementation(async (name) => {
      if (name === 'parent') return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      // intermediate never has a fix
      return { dependencies: { 'vulnerable-pkg': '^1.0.0' }, peerDependencies: {} };
    });
    // 15 intermediate versions available
    const versions = Array.from({ length: 15 }, (_, i) => `1.${14 - i}.0`);
    getPublishedVersions.mockResolvedValueOnce(versions);

    await recursiveResolveChainChildRange(
      'parent', '1.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );

    const intermediateFetches = getManifest.mock.calls.filter(c => c[0] === 'intermediate');
    expect(intermediateFetches.length).toBeLessThanOrEqual(10);
  });

  test('deterministic ordering: tries highest semver candidates first', async () => {
    const order = [];
    getManifest.mockImplementation(async (name, version) => {
      if (name === 'parent') return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      order.push(version);
      // Never covers fix, so exploration tries all
      return { dependencies: { 'vulnerable-pkg': '^1.0.0' }, peerDependencies: {} };
    });
    getPublishedVersions.mockResolvedValueOnce(['1.1.0', '1.3.0', '1.2.0']);

    await recursiveResolveChainChildRange(
      'parent', '1.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );

    expect(order[0]).toBe('1.3.0'); // highest first
  });
});

describe('recursiveResolveChainChildRange — recursive path finding', () => {
  test('single intermediate: latest version covers fix', async () => {
    getManifest.mockImplementation(async (name, version) => {
      if (name === 'parent' && version === '2.0.0')
        return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      if (name === 'intermediate' && version === '1.5.0')
        return { dependencies: { 'vulnerable-pkg': '^2.0.0' }, peerDependencies: {} };
      return null;
    });
    getPublishedVersions.mockResolvedValueOnce(['1.5.0', '1.3.0']);

    const range = await recursiveResolveChainChildRange(
      'parent', '2.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBe('^2.0.0');
  });

  test('Step G core: non-latest intermediate has the fix — exploration continues past latest', async () => {
    // intermediate@1.5.0 (latest) has ^1.x → does NOT cover 2.0.0
    // intermediate@1.3.0 has ^2.x → covers 2.0.0 → found!
    getManifest.mockImplementation(async (name, version) => {
      if (name === 'parent' && version === '2.0.0')
        return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      if (name === 'intermediate' && version === '1.5.0')
        return { dependencies: { 'vulnerable-pkg': '^1.0.0' }, peerDependencies: {} };
      if (name === 'intermediate' && version === '1.3.0')
        return { dependencies: { 'vulnerable-pkg': '^2.0.0' }, peerDependencies: {} };
      return null;
    });
    getPublishedVersions.mockResolvedValueOnce(['1.5.0', '1.3.0']);

    const range = await recursiveResolveChainChildRange(
      'parent', '2.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBe('^2.0.0');
  });

  test('two-level chain: root → A → B → child', async () => {
    getManifest.mockImplementation(async (name, version) => {
      if (name === 'root' && version === '3.0.0')
        return { dependencies: { a: '^1.0.0' }, peerDependencies: {} };
      if (name === 'a' && version === '1.2.0')
        return { dependencies: { b: '^2.0.0' }, peerDependencies: {} };
      if (name === 'b' && version === '2.5.0')
        return { dependencies: { child: '^3.0.0' }, peerDependencies: {} };
      return null;
    });
    getPublishedVersions
      .mockResolvedValueOnce(['1.2.0', '1.0.0']) // a versions
      .mockResolvedValueOnce(['2.5.0', '2.0.0']); // b versions

    const range = await recursiveResolveChainChildRange(
      'root', '3.0.0', ['a', 'b'], 'child', '3.0.0', ctx()
    );
    expect(range).toBe('^3.0.0');
  });

  test('no intermediate version covers fix → null', async () => {
    getManifest.mockImplementation(async (name) => {
      if (name === 'parent') return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      return { dependencies: { 'vulnerable-pkg': '^1.0.0' }, peerDependencies: {} }; // never fixes
    });
    getPublishedVersions.mockResolvedValueOnce(['1.5.0', '1.3.0']);

    const range = await recursiveResolveChainChildRange(
      'parent', '2.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
  });

  test('getPublishedVersions returns null → null', async () => {
    getManifest.mockResolvedValueOnce({ dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} });
    getPublishedVersions.mockResolvedValueOnce(null);

    const range = await recursiveResolveChainChildRange(
      'parent', '2.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
  });

  test('intermediate not in manifest deps → null, no versions fetched', async () => {
    getManifest.mockResolvedValueOnce({ dependencies: { other: '^1.0.0' }, peerDependencies: {} });

    const range = await recursiveResolveChainChildRange(
      'parent', '2.0.0', ['intermediate'], 'vulnerable-pkg', '2.0.0', ctx()
    );
    expect(range).toBeNull();
    expect(getPublishedVersions).not.toHaveBeenCalled();
  });
});

// ── findParentUpgradePaths ───────────────────────────────────────────────────

describe('findParentUpgradePaths', () => {
  function makeItem(overrides) {
    return {
      libraryName:        'vulnerable-pkg',
      currentVersion:     '1.0.0',
      recommendedVersion: '2.0.0',
      upgradeType:        'MAJOR_BUMP',
      phase:              'C',
      cves:               [{ id: 'CVE-001' }],
      rootParents:        [],
      ...overrides,
    };
  }

  test('returns [] when rootParents is empty', async () => {
    const paths = await findParentUpgradePaths(makeItem());
    expect(paths).toHaveLength(0);
  });

  test('returns [] when recommendedVersion is missing', async () => {
    const item = makeItem({ recommendedVersion: undefined, rootParents: [{ name: 'root', range: '^1.0.0' }] });
    const paths = await findParentUpgradePaths(item);
    expect(paths).toHaveLength(0);
  });

  test('returns [] when no versions satisfy root range', async () => {
    getPublishedVersions.mockResolvedValueOnce([]);
    const item = makeItem({ rootParents: [{ name: 'root', range: '^3.0.0', isDev: false }] });
    const paths = await findParentUpgradePaths(item);
    expect(paths).toHaveLength(0);
  });

  test('direct parent: finds fix when child range covers recommended version', async () => {
    getPublishedVersions.mockResolvedValueOnce(['1.5.0', '1.3.0']);
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });

    const item = makeItem({
      rootParents: [{ name: 'root', range: '^1.0.0', isDev: false }],
    });
    const paths = await findParentUpgradePaths(item);
    expect(paths).toHaveLength(1);
    expect(paths[0].parent).toBe('root');
    expect(paths[0].parentUpgradeVersion).toBe('1.5.0');
    expect(paths[0].childDeclaredRange).toBe('^2.0.0');
    expect(paths[0].manifestVerified).toBe(true);
    expect(paths[0].chainVia).toEqual([]);
  });

  test('indirect chain: finds fix via recursive exploration of non-latest intermediate', async () => {
    // root@^2.0.0 → intermediate → vulnerable-pkg
    // intermediate@1.5.0 (latest) has ^1.x (no fix); intermediate@1.3.0 has ^2.x (fix!)
    getPublishedVersions
      .mockResolvedValueOnce(['2.1.0'])            // root versions
      .mockResolvedValueOnce(['1.5.0', '1.3.0']);  // intermediate versions

    getManifest.mockImplementation(async (name, version) => {
      if (name === 'root' && version === '2.1.0')
        return { dependencies: { intermediate: '^1.0.0' }, peerDependencies: {} };
      if (name === 'intermediate' && version === '1.5.0')
        return { dependencies: { 'vulnerable-pkg': '^1.0.0' }, peerDependencies: {} };
      if (name === 'intermediate' && version === '1.3.0')
        return { dependencies: { 'vulnerable-pkg': '^2.0.0' }, peerDependencies: {} };
      return null;
    });

    const item = makeItem({
      rootParents: [{
        name: 'root', range: '^2.0.0', isDev: false, chainVia: ['intermediate'],
      }],
    });
    const paths = await findParentUpgradePaths(item);
    expect(paths).toHaveLength(1);
    expect(paths[0].parent).toBe('root');
    expect(paths[0].childDeclaredRange).toBe('^2.0.0');
    expect(paths[0].chainVia).toEqual(['intermediate']);
    expect(paths[0].manifestVerified).toBe(true);
  });

  test('respects maxDepth option', async () => {
    // With maxDepth=1, the recursion bails before reaching the child
    getPublishedVersions
      .mockResolvedValueOnce(['2.0.0'])   // root
      .mockResolvedValueOnce(['1.0.0']);  // a
    getManifest.mockImplementation(async (name) => {
      if (name === 'root') return { dependencies: { a: '^1.0.0' }, peerDependencies: {} };
      if (name === 'a')    return { dependencies: { b: '^1.0.0' }, peerDependencies: {} };
      return null;
    });

    const item = makeItem({
      rootParents: [{ name: 'root', range: '^2.0.0', isDev: false, chainVia: ['a', 'b'] }],
    });
    // depth 0 = root→a fetch, depth 1 = a: chain still has ['b'], depth >= maxDepth(1) → bail
    const paths = await findParentUpgradePaths(item, { maxDepth: 1 });
    expect(paths).toHaveLength(0);
  });
});

// ── exploreParentUpgrades ────────────────────────────────────────────────────

describe('exploreParentUpgrades', () => {
  function makePhaseC(overrides) {
    return {
      libraryName:        'vulnerable-pkg',
      currentVersion:     '1.0.0',
      recommendedVersion: '2.0.0',
      upgradeType:        'MAJOR_BUMP',
      phase:              'C',
      cves:               [{ id: 'CVE-001' }],
      rootParents:        [{ name: 'root', range: '^1.0.0', isDev: false }],
      ...overrides,
    };
  }

  test('non-npm ecosystem: returns without modifying plan', async () => {
    const item = makePhaseC();
    await exploreParentUpgrades([item], 'maven', null, null);
    expect(item.phase).toBe('C');
    expect(getPublishedVersions).not.toHaveBeenCalled();
  });

  test('no MAJOR_BUMP Phase C items: no-op', async () => {
    const item = { ...makePhaseC(), phase: 'A' };
    await exploreParentUpgrades([item], 'npm', null, null);
    expect(item.phase).toBe('A');
    expect(getPublishedVersions).not.toHaveBeenCalled();
  });

  test('promotes Phase C → B when parent upgrade path found (no simulation)', async () => {
    getPublishedVersions.mockResolvedValueOnce(['1.5.0']);
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });

    const item = makePhaseC();
    await exploreParentUpgrades([item], 'npm', null, null);

    expect(item.phase).toBe('B');
    expect(item.parentUpgradePaths).toHaveLength(1);
    expect(item._parentExplorationRan).toBe(true);
    expect(item.justification).toContain('MAJOR_BUMP resolved via parent upgrade');
  });

  test('stays Phase C when no parent upgrade path found', async () => {
    getPublishedVersions.mockResolvedValueOnce(['1.5.0']);
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^1.0.0' }, // old range, no fix
      peerDependencies: {},
    });

    const item = makePhaseC();
    await exploreParentUpgrades([item], 'npm', null, null);

    expect(item.phase).toBe('C');
    expect(item._parentExplorationRan).toBe(true);
    expect(item.parentUpgradePaths).toBeUndefined();
  });

  test('simulation limit: stops simulating after maxSimulations, second path stays INFERRED', async () => {
    // Two items each with one path; maxSimulations=1 → second item path not simulated
    getPublishedVersions.mockResolvedValue(['1.5.0']);
    getManifest.mockResolvedValue({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });
    simulate.mockReturnValue([{
      success: true, timedOut: false, limitExceeded: false,
      resolvedVersions: new Map([['vulnerable-pkg', '2.0.0']]),
    }]);

    const item1 = makePhaseC();
    const item2 = makePhaseC({ cves: [{ id: 'CVE-002' }] });

    await exploreParentUpgrades([item1, item2], 'npm', '/fake/package.json', null,
      { maxSimulations: 1 });

    expect(simulate).toHaveBeenCalledTimes(1); // only item1 simulated
    expect(item1.parentUpgradePaths[0].simulationVerified).toBe(true);
    // item2 path exists but no simulation ran
    expect(item2.parentUpgradePaths[0].simulationVerified).toBeUndefined();
  });

  test('simulation verified: marks path.simulationVerified = true on success', async () => {
    getPublishedVersions.mockResolvedValueOnce(['1.5.0']);
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });
    simulate.mockReturnValueOnce([{
      success: true, timedOut: false, limitExceeded: false,
      resolvedVersions: new Map([['vulnerable-pkg', '2.0.0']]),
    }]);

    const item = makePhaseC();
    await exploreParentUpgrades([item], 'npm', '/fake/package.json', null);

    expect(item.parentUpgradePaths[0].simulationVerified).toBe(true);
  });

  test('simulation timedOut: phase promoted but path stays INFERRED (fail-open)', async () => {
    getPublishedVersions.mockResolvedValueOnce(['1.5.0']);
    getManifest.mockResolvedValueOnce({
      dependencies: { 'vulnerable-pkg': '^2.0.0' },
      peerDependencies: {},
    });
    simulate.mockReturnValueOnce([{
      success: false, timedOut: true, limitExceeded: false,
      resolvedVersions: new Map(),
    }]);

    const item = makePhaseC();
    await exploreParentUpgrades([item], 'npm', '/fake/package.json', null);

    expect(item.phase).toBe('B'); // phase promoted (path was found)
    expect(item.parentUpgradePaths[0].simulationVerified).toBeUndefined();
  });
});
