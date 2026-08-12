'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// We mock simulator.js so tests don't run real npm installs.
jest.mock('../../../src/ecosystems/npm/simulator', () => ({
  simulate: jest.fn(),
  simulatePackage: jest.fn(),
}));

const { simulatePackage } = require('../../../src/ecosystems/npm/simulator');
const { minimizeOverrides } = require('../../../src/ecosystems/npm/override-minimizer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempPkg(overrides, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-test-'));
  const pkg = {
    name: 'test-app',
    version: '1.0.0',
    dependencies: { react: '^18.0.0' },
    overrides: { ...overrides },
    ...extra,
  };
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return { dir, pkgPath };
}

function makeSimResult(resolvedMap, opts = {}) {
  return {
    success:          opts.success  ?? true,
    limitExceeded:    opts.limitExceeded ?? false,
    timedOut:         false,
    peerConflicts:    [],
    resolvedVersions: new Map(Object.entries(resolvedMap)),
    error:            null,
  };
}

// ---------------------------------------------------------------------------
// Tests — override-minimizer
// ---------------------------------------------------------------------------

afterEach(() => {
  jest.clearAllMocks();
});

describe('minimizeOverrides — no overrides', () => {
  test('returns empty result when package.json has no overrides', () => {
    const { pkgPath, dir } = writeTempPkg({});
    delete JSON.parse(fs.readFileSync(pkgPath, 'utf8')).overrides;
    // Re-write without overrides key
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    delete pkg.overrides;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(simulatePackage).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — single override can be removed', () => {
  test('removes override when simulation resolves at >= pinned version', () => {
    const { pkgPath, dir } = writeTempPkg({ lodash: '4.17.21' });

    simulatePackage.mockReturnValue(makeSimResult({ lodash: '4.17.21' }));

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.removed).toContain('lodash');
    expect(result.kept).not.toContain('lodash');
    expect(simulatePackage).toHaveBeenCalledTimes(1);

    fs.rmSync(dir, { recursive: true });
  });

  test('keeps override when simulation resolves to older version', () => {
    const { pkgPath, dir } = writeTempPkg({ lodash: '4.17.21' });

    simulatePackage.mockReturnValue(makeSimResult({ lodash: '4.17.15' }));

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.kept).toContain('lodash');
    expect(result.removed).not.toContain('lodash');

    fs.rmSync(dir, { recursive: true });
  });

  test('keeps override when simulation fails (npm error)', () => {
    const { pkgPath, dir } = writeTempPkg({ axios: '1.6.0' });

    simulatePackage.mockReturnValue({ ...makeSimResult({}), success: false, error: 'ERESOLVE' });

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.kept).toContain('axios');
    expect(result.removed).not.toContain('axios');

    fs.rmSync(dir, { recursive: true });
  });

  test('keeps override when package not in resolved versions after removal', () => {
    const { pkgPath, dir } = writeTempPkg({ 'some-pkg': '2.0.0' });

    // Resolved versions don't include some-pkg (it disappeared entirely)
    simulatePackage.mockReturnValue(makeSimResult({}));

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.kept).toContain('some-pkg');

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — simulation limit', () => {
  test('stops and marks remaining as kept when limit is hit', () => {
    const { pkgPath, dir } = writeTempPkg({ a: '1.0.0', b: '2.0.0', c: '3.0.0' });

    // First call hits the limit
    simulatePackage.mockReturnValueOnce({ ...makeSimResult({}), success: false, limitExceeded: true });

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.limitHit).toBe(true);
    // All three should be in kept (none tested successfully)
    expect(result.kept.length).toBe(3);
    expect(result.removed.length).toBe(0);

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — multiple overrides', () => {
  test('removes all when simulation confirms all unnecessary', () => {
    const { pkgPath, dir } = writeTempPkg({ a: '1.1.0', b: '2.2.0' });

    simulatePackage
      .mockReturnValueOnce(makeSimResult({ a: '1.1.0' }))   // a removable
      .mockReturnValueOnce(makeSimResult({ b: '2.2.0' }));  // b removable

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.removed).toContain('a');
    expect(result.removed).toContain('b');
    expect(result.kept.length).toBe(0);

    fs.rmSync(dir, { recursive: true });
  });

  test('keeps only what is needed when one of two overrides resolves correctly without it', () => {
    const { pkgPath, dir } = writeTempPkg({ 'pkg-a': '1.2.0', 'pkg-b': '3.0.0' });

    simulatePackage
      .mockReturnValueOnce(makeSimResult({ 'pkg-a': '1.2.0' }))  // pkg-a: removable
      .mockReturnValueOnce(makeSimResult({ 'pkg-b': '2.9.9' })); // pkg-b: still needed (old ver)

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.removed).toContain('pkg-a');
    expect(result.kept).toContain('pkg-b');

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — nested overrides', () => {
  test('skips nested (object-value) overrides', () => {
    const { pkgPath, dir } = writeTempPkg({
      'flat-pkg': '1.0.0',
      'parent': { 'child': '2.0.0' },
    });

    simulatePackage.mockReturnValue(makeSimResult({ 'flat-pkg': '1.0.0' }));

    const result = minimizeOverrides(pkgPath, null, { dryRun: true });
    expect(result.skipped).toContain('parent');
    expect(result.removed).toContain('flat-pkg');

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — file write (dryRun: false)', () => {
  test('writes updated package.json when dryRun is false', () => {
    const { pkgPath, dir } = writeTempPkg({ lodash: '4.17.21' });

    simulatePackage.mockReturnValue(makeSimResult({ lodash: '4.17.21' }));

    const result = minimizeOverrides(pkgPath, null, { dryRun: false });
    expect(result.removed).toContain('lodash');

    const written = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(written.overrides).toBeUndefined();

    fs.rmSync(dir, { recursive: true });
  });

  test('does not write file when dryRun is true', () => {
    const { pkgPath, dir } = writeTempPkg({ lodash: '4.17.21' });
    const originalContent = fs.readFileSync(pkgPath, 'utf8');

    simulatePackage.mockReturnValue(makeSimResult({ lodash: '4.17.21' }));

    minimizeOverrides(pkgPath, null, { dryRun: true });

    expect(fs.readFileSync(pkgPath, 'utf8')).toBe(originalContent);

    fs.rmSync(dir, { recursive: true });
  });
});

describe('minimizeOverrides — error handling', () => {
  test('throws when package.json does not exist', () => {
    expect(() => minimizeOverrides('/nonexistent/package.json', null, { dryRun: true }))
      .toThrow('not found');
  });
});
