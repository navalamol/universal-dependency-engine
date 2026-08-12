'use strict';

const { captureGraph, diffGraphs, formatDiff } = require('../../src/core/graph-diff');
const path = require('path');

// ---------------------------------------------------------------------------
// captureGraph
// ---------------------------------------------------------------------------

describe('captureGraph', () => {
  test('returns null when file does not exist', () => {
    expect(captureGraph('/nonexistent/path/package-lock.json')).toBeNull();
  });

  test('returns null when lockFilePath is null', () => {
    expect(captureGraph(null)).toBeNull();
  });

  test('parses real fixture and returns a Map with version arrays', () => {
    const lockPath = path.join(__dirname, '..', 'fixtures', 'package-lock-v2.json');
    const graph = captureGraph(lockPath);
    expect(graph).toBeInstanceOf(Map);
    expect(graph.size).toBeGreaterThan(0);
    for (const [name, versions] of graph) {
      expect(typeof name).toBe('string');
      expect(Array.isArray(versions)).toBe(true);
      expect(versions.length).toBeGreaterThan(0);
      // All versions should be valid semver
      for (const v of versions) {
        const semver = require('semver');
        expect(semver.valid(v)).not.toBeNull();
      }
    }
  });

  test('versions array is sorted ascending', () => {
    const semver = require('semver');
    const lockPath = path.join(__dirname, '..', 'fixtures', 'package-lock-v2.json');
    const graph = captureGraph(lockPath);
    for (const [, versions] of graph) {
      for (let i = 1; i < versions.length; i++) {
        expect(semver.lte(versions[i - 1], versions[i])).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// diffGraphs — helpers for building test maps
// ---------------------------------------------------------------------------

function makeGraph(entries) {
  const m = new Map();
  for (const [name, ...versions] of entries) m.set(name, versions);
  return m;
}

describe('diffGraphs — null handling', () => {
  test('null before treats all after packages as added', () => {
    const after = makeGraph([['lodash', '4.17.21'], ['axios', '1.6.0']]);
    const diff = diffGraphs(null, after);
    expect(diff.added.length).toBe(2);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
  });

  test('null after treats all before packages as removed', () => {
    const before = makeGraph([['lodash', '4.17.15']]);
    const diff = diffGraphs(before, null);
    expect(diff.removed.length).toBe(1);
    expect(diff.added.length).toBe(0);
  });

  test('both null returns empty diff', () => {
    const diff = diffGraphs(null, null);
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
    expect(diff.unchangedCount).toBe(0);
  });
});

describe('diffGraphs — version changes', () => {
  test('detects changed package (single version bump)', () => {
    const before = makeGraph([['lodash', '4.17.15']]);
    const after  = makeGraph([['lodash', '4.17.21']]);
    const diff = diffGraphs(before, after);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]).toEqual({ name: 'lodash', from: ['4.17.15'], to: ['4.17.21'] });
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.unchangedCount).toBe(0);
  });

  test('detects added package', () => {
    const before = makeGraph([['lodash', '4.17.15']]);
    const after  = makeGraph([['lodash', '4.17.15'], ['axios', '1.6.0']]);
    const diff = diffGraphs(before, after);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0].name).toBe('axios');
    expect(diff.changed.length).toBe(0);
    expect(diff.unchangedCount).toBe(1);
  });

  test('detects removed package', () => {
    const before = makeGraph([['lodash', '4.17.15'], ['axios', '1.6.0']]);
    const after  = makeGraph([['lodash', '4.17.15']]);
    const diff = diffGraphs(before, after);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0].name).toBe('axios');
    expect(diff.unchangedCount).toBe(1);
  });

  test('unchanged packages are counted correctly', () => {
    const before = makeGraph([['a', '1.0.0'], ['b', '2.0.0'], ['c', '3.0.0']]);
    const after  = makeGraph([['a', '1.0.0'], ['b', '2.1.0'], ['c', '3.0.0']]);
    const diff = diffGraphs(before, after);
    expect(diff.unchangedCount).toBe(2); // a and c
    expect(diff.changed.length).toBe(1); // b
  });

  test('multi-version changes are detected', () => {
    const before = makeGraph([['pkg', '1.0.0', '2.0.0']]);
    const after  = makeGraph([['pkg', '1.0.0', '2.1.0']]);
    const diff = diffGraphs(before, after);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0].from).toEqual(['1.0.0', '2.0.0']);
    expect(diff.changed[0].to).toEqual(['1.0.0', '2.1.0']);
  });

  test('output arrays are sorted by name', () => {
    const before = makeGraph([['z', '1.0.0'], ['a', '1.0.0']]);
    const after  = makeGraph([['z', '2.0.0'], ['a', '2.0.0']]);
    const diff = diffGraphs(before, after);
    expect(diff.changed[0].name).toBe('a');
    expect(diff.changed[1].name).toBe('z');
  });
});

// ---------------------------------------------------------------------------
// formatDiff
// ---------------------------------------------------------------------------

describe('formatDiff', () => {
  test('produces markdown string', () => {
    const diff = {
      added:          [{ name: 'new-pkg', versions: ['1.0.0'] }],
      removed:        [{ name: 'old-pkg', versions: ['0.9.0'] }],
      changed:        [{ name: 'lodash', from: ['4.17.15'], to: ['4.17.21'] }],
      unchangedCount: 50,
    };
    const md = formatDiff(diff, { project: 'my-app', reportDate: '2026-08-12' });
    expect(typeof md).toBe('string');
    expect(md).toContain('# Dependency Graph Diff');
    expect(md).toContain('my-app');
    expect(md).toContain('Changed');
    expect(md).toContain('Added');
    expect(md).toContain('Removed');
    expect(md).toContain('lodash');
    expect(md).toContain('4.17.15');
    expect(md).toContain('4.17.21');
    expect(md).toContain('new-pkg');
    expect(md).toContain('old-pkg');
  });

  test('shows no-change message when diff is empty', () => {
    const diff = { added: [], removed: [], changed: [], unchangedCount: 100 };
    const md = formatDiff(diff);
    expect(md).toContain('No changes');
  });

  test('summary line shows counts', () => {
    const diff = {
      added: [{ name: 'x', versions: ['1.0.0'] }],
      removed: [],
      changed: [{ name: 'y', from: ['1.0.0'], to: ['2.0.0'] }],
      unchangedCount: 10,
    };
    const md = formatDiff(diff);
    expect(md).toContain('1 changed');
    expect(md).toContain('1 added');
    expect(md).toContain('0 removed');
  });
});
