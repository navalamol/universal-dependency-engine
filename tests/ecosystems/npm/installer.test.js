'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { detectManualChanges } = require('../../../src/ecosystems/npm/installer');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mendfix-test-'));
}

describe('detectManualChanges — override removal and modification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(overrides) {
    const manifest = { _tool: 'mend-autofixer', _date: '2026-01-01', overrides };
    fs.writeFileSync(path.join(tmpDir, '.mend-manifest.json'), JSON.stringify(manifest, null, 2));
  }

  function writePackageJson(overrides) {
    const pkg = { name: 'test', overrides: overrides || undefined };
    if (!overrides) delete pkg.overrides;
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2));
  }

  test('no conflict when tool-written value is unchanged', () => {
    writeManifest({ 'test-pkg': '1.2.3' });
    writePackageJson({ 'test-pkg': '1.2.3' });
    const conflicts = detectManualChanges(path.join(tmpDir, 'package.json'), { 'test-pkg': '1.2.3' });
    expect(conflicts).toHaveLength(0);
  });

  test('conflict detected when override was modified', () => {
    writeManifest({ 'test-pkg': '1.2.3' });
    writePackageJson({ 'test-pkg': '2.0.0' });
    const conflicts = detectManualChanges(path.join(tmpDir, 'package.json'), { 'test-pkg': '1.2.3' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].pkgName).toBe('test-pkg');
  });

  test('conflict detected when override was removed (P0-3 fix)', () => {
    writeManifest({ 'test-pkg': '1.2.3' });
    writePackageJson(null); // no overrides key at all
    const conflicts = detectManualChanges(path.join(tmpDir, 'package.json'), { 'test-pkg': '1.2.3' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].pkgName).toBe('test-pkg');
  });

  test('no conflict for key not previously written by tool', () => {
    writeManifest({});
    writePackageJson({ 'other-pkg': '3.0.0' });
    const conflicts = detectManualChanges(path.join(tmpDir, 'package.json'), { 'other-pkg': '3.0.0' });
    expect(conflicts).toHaveLength(0);
  });
});
