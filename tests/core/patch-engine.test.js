'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const {
  PATCH_STATUS,
  hashDiff,
  createPatch,
  applyPatch,
  verifyPatch,
  writePatchFile,
  buildPatchEvidence,
} = require('../../src/core/patch-engine');

// ─── hashDiff ────────────────────────────────────────────────────────────────
describe('hashDiff', () => {
  test('produces a 64-char hex string', () => {
    const h = hashDiff('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic', () => {
    expect(hashDiff('abc')).toBe(hashDiff('abc'));
  });

  test('different inputs produce different hashes', () => {
    expect(hashDiff('a')).not.toBe(hashDiff('b'));
  });

  test('empty string returns stable hash', () => {
    const h = hashDiff('');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── createPatch ─────────────────────────────────────────────────────────────
describe('createPatch', () => {
  test('creates a PatchData record with expected fields', () => {
    const p = createPatch('lodash', '4.17.15', '4.17.21', '--- old\n+++ new\n@@ -1 +1 @@\n-x\n+y');
    expect(p.pkgName).toBe('lodash');
    expect(p.fromVersion).toBe('4.17.15');
    expect(p.toVersion).toBe('4.17.21');
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.status).toBe(PATCH_STATUS.CREATED);
    expect(typeof p.createdAt).toBe('string');
  });

  test('hash of diff matches hashDiff result', () => {
    const diff = '--- a\n+++ b\n';
    const p = createPatch('pkg', '1.0.0', '1.0.1', diff);
    expect(p.hash).toBe(hashDiff(diff));
  });

  test('empty diff is allowed', () => {
    const p = createPatch('pkg', '1.0.0', '1.0.1');
    expect(p.diff).toBe('');
    expect(p.hash).toBe(hashDiff(''));
  });

  test('throws if pkgName missing', () => {
    expect(() => createPatch('', '1.0.0', '1.0.1')).toThrow('pkgName required');
  });

  test('throws if fromVersion missing', () => {
    expect(() => createPatch('pkg', '', '1.0.1')).toThrow('fromVersion required');
  });

  test('throws if toVersion missing', () => {
    expect(() => createPatch('pkg', '1.0.0', '')).toThrow('toVersion required');
  });
});

// ─── verifyPatch ─────────────────────────────────────────────────────────────
describe('verifyPatch', () => {
  test('verified when diff matches stored hash', () => {
    const p = createPatch('pkg', '1.0.0', '1.0.1', 'diff content');
    const r = verifyPatch(p);
    expect(r.verified).toBe(true);
    expect(r.storedHash).toBe(r.computedHash);
  });

  test('not verified when diff is tampered', () => {
    const p = createPatch('pkg', '1.0.0', '1.0.1', 'original');
    const tampered = { ...p, diff: 'tampered' };
    const r = verifyPatch(tampered);
    expect(r.verified).toBe(false);
    expect(r.storedHash).not.toBe(r.computedHash);
  });

  test('returns false when patchData is null', () => {
    const r = verifyPatch(null);
    expect(r.verified).toBe(false);
    expect(r.storedHash).toBeNull();
  });

  test('returns false when diff is not a string', () => {
    const r = verifyPatch({ diff: 42 });
    expect(r.verified).toBe(false);
  });
});

// ─── applyPatch ──────────────────────────────────────────────────────────────
describe('applyPatch', () => {
  test('dryRun returns applied:false without touching disk', () => {
    const p = createPatch('lodash', '4.0.0', '4.1.0', 'some diff');
    const r = applyPatch('/nonexistent', p, { dryRun: true });
    expect(r.applied).toBe(false);
    expect(r.dryRun).toBe(true);
  });

  test('returns error if installDir is missing', () => {
    const p = createPatch('lodash', '4.0.0', '4.1.0', 'diff');
    const r = applyPatch('', p);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/installDir required/);
  });

  test('returns error if diff is empty', () => {
    const p = createPatch('lodash', '4.0.0', '4.1.0', '');
    const r = applyPatch('/tmp/fake', p);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/empty/);
  });

  test('returns error if installDir does not exist (non-dry run)', () => {
    const p = createPatch('lodash', '4.0.0', '4.1.0', 'diff content');
    const r = applyPatch('/definitely/does/not/exist/12345', p);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/installDir not found/);
  });

  test('writes patch file to a real temp directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-engine-test-'));
    try {
      const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n';
      const p    = createPatch('mypkg', '1.0.0', '1.0.1', diff);
      const r    = applyPatch(tmpDir, p);
      expect(r.applied).toBe(true);
      expect(fs.existsSync(r.patchFile)).toBe(true);
      expect(fs.readFileSync(r.patchFile, 'utf8')).toBe(diff);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── writePatchFile ───────────────────────────────────────────────────────────
describe('writePatchFile', () => {
  test('writes file and returns path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-write-test-'));
    try {
      const p       = createPatch('express', '4.18.0', '4.18.2', 'patch content');
      const written = writePatchFile(p, tmpDir);
      expect(fs.existsSync(written)).toBe(true);
      expect(written).toContain('express-4.18.0-to-4.18.2.patch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('creates outDir if it does not exist', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-mkdir-test-'));
    const newDir  = path.join(tmpBase, 'sub', 'dir');
    try {
      const p = createPatch('pkg', '1.0.0', '1.0.1', 'content');
      writePatchFile(p, newDir);
      expect(fs.existsSync(newDir)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

// ─── buildPatchEvidence ────────────────────────────────────────────────────────
describe('buildPatchEvidence', () => {
  test('returns expected fields', () => {
    const p = createPatch('axios', '1.0.0', '1.1.0', 'diff');
    const e = buildPatchEvidence(p);
    expect(e.patchHash).toBe(p.hash);
    expect(e.patchFrom).toBe('1.0.0');
    expect(e.patchTo).toBe('1.1.0');
    expect(e.patchStatus).toBe(PATCH_STATUS.CREATED);
    expect(typeof e.patchCreatedAt).toBe('string');
  });
});
