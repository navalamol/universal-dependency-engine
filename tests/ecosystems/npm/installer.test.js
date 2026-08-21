'use strict';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
const { spawnSync } = require('child_process');

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { detectManualChanges, runPackageLockUpdate } = require('../../../src/ecosystems/npm/installer');

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

// ─── runPackageLockUpdate — Windows .cmd fix ──────────────────────────────────

describe('runPackageLockUpdate — Windows .cmd invocation', () => {
  beforeEach(() => { spawnSync.mockReset(); });

  test('returns success:true when spawnSync exits 0', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const result = runPackageLockUpdate('/project');
    expect(result.success).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  test('returns success:false when spawnSync exits non-zero', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'npm error' });
    const result = runPackageLockUpdate('/project');
    expect(result.success).toBe(false);
    expect(result.stderr).toBe('npm error');
  });

  test('returns success:false and status null when process fails to spawn', () => {
    spawnSync.mockReturnValue({ status: null, stdout: null, stderr: null, error: new Error('ENOENT') });
    const result = runPackageLockUpdate('/project');
    expect(result.success).toBe(false);
    expect(result.status).toBeNull();
  });

  test('on Windows with .cmd path, spawns via cmd.exe /c', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

    runPackageLockUpdate('C:\\project');

    const [calledExe, calledArgs] = spawnSync.mock.calls[0];
    const isCmdExe = /cmd\.exe$/i.test(calledExe) || calledExe === (process.env.COMSPEC || 'cmd.exe');
    // Either cmd.exe is used as exe, or the first arg is /c (cmd.exe /c npm.cmd ...)
    const usesCmd = isCmdExe || (calledArgs[0] === '/c');
    expect(usesCmd).toBe(true);

    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  test('npm install args always include --legacy-peer-deps and --package-lock-only', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    runPackageLockUpdate('/project');
    const allArgs = spawnSync.mock.calls[0].flat();
    expect(allArgs).toContain('--legacy-peer-deps');
    expect(allArgs).toContain('--package-lock-only');
  });
});
