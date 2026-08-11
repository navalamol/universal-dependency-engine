'use strict';

const path = require('path');
const { parseLockFile } = require('../../../src/ecosystems/npm/lock-parser');

const FIXTURES = path.join(__dirname, '../../fixtures');

describe('parseLockFile', () => {
  test('v3 lock file — simple parent→child chain', () => {
    const depTree = parseLockFile(path.join(FIXTURES, 'package-lock-v3.json'));
    // child-b appears under parent-a
    const entries = depTree.get('child-b');
    expect(entries).toBeDefined();
    expect(entries.length).toBeGreaterThan(0);
  });

  test('v2 lock file — dep-x entry exists', () => {
    const depTree = parseLockFile(path.join(FIXTURES, 'package-lock-v2.json'));
    const entries = depTree.get('dep-x');
    expect(entries).toBeDefined();
    expect(entries[0].resolvedVersion).toBe('1.3.0');
  });

  test('scoped package @scope/scoped-pkg is keyed correctly', () => {
    const depTree = parseLockFile(path.join(FIXTURES, 'package-lock-v3.json'));
    const entries = depTree.get('@scope/scoped-pkg');
    expect(entries).toBeDefined();
    expect(entries[0].resolvedVersion).toBe('3.0.1');
  });

  test('dev-only entry has dev:true', () => {
    const depTree = parseLockFile(path.join(FIXTURES, 'package-lock-v3.json'));
    const entries = depTree.get('dev-only-pkg');
    expect(entries).toBeDefined();
    expect(entries[0].dev).toBe(true);
  });

  test('v1-only lock file (no packages key) throws', () => {
    expect(() => parseLockFile(path.join(FIXTURES, 'package-lock-v3.json').replace('v3', 'v1-missing'))).toThrow();
  });
});
