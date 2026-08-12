'use strict';

const { buildBlastRadius } = require('../../../src/ecosystems/npm/lock-parser');

function makeDepTree(entries) {
  // entries: [{ name, version, dev, parents: [{name, range}] }]
  const tree = new Map();
  for (const e of entries) {
    if (!tree.has(e.name)) tree.set(e.name, []);
    tree.get(e.name).push({
      resolvedVersion: e.version,
      dev: e.dev || false,
      requires: {},
      parents: e.parents || [],
    });
  }
  return tree;
}

describe('buildBlastRadius', () => {
  test('returns zeros for unknown package', () => {
    const tree = makeDepTree([]);
    const r    = buildBlastRadius('nonexistent', tree);
    expect(r.directCount).toBe(0);
    expect(r.transitiveCount).toBe(0);
    expect(r.consumers).toEqual([]);
  });

  test('counts direct consumers', () => {
    const tree = makeDepTree([
      { name: 'x', version: '1.0.0', dev: false, parents: [{ name: 'a', range: '^1.0.0' }, { name: 'b', range: '^1.0.0' }] },
      { name: 'a', version: '2.0.0', dev: false, parents: [] },
      { name: 'b', version: '3.0.0', dev: false, parents: [] },
    ]);
    const r = buildBlastRadius('x', tree);
    expect(r.directCount).toBe(2);
    expect(r.consumers).toContain('a');
    expect(r.consumers).toContain('b');
  });

  test('counts transitive consumers', () => {
    // chain: root → a → b → x
    const tree = makeDepTree([
      { name: 'x', version: '1.0.0', dev: false, parents: [{ name: 'b', range: '*' }] },
      { name: 'b', version: '1.0.0', dev: false, parents: [{ name: 'a', range: '*' }] },
      { name: 'a', version: '1.0.0', dev: false, parents: [] },
    ]);
    const r = buildBlastRadius('x', tree);
    expect(r.directCount).toBe(1);   // b
    expect(r.transitiveCount).toBe(2);  // b + a
    expect(r.consumers).toContain('a');
    expect(r.consumers).toContain('b');
  });

  test('separates production and dev counts', () => {
    const tree = makeDepTree([
      { name: 'x', version: '1.0.0', dev: false, parents: [{ name: 'a', range: '^1' }] },
      { name: 'x', version: '1.0.0', dev: true,  parents: [{ name: 'jest', range: '^1' }] },
    ]);
    const r = buildBlastRadius('x', tree);
    expect(r.productionCount).toBe(1);
    expect(r.devCount).toBe(1);
  });
});
