'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const {
  DISCLOSURE_STATUS,
  buildDisclosureDraft,
  renderDisclosureDraft,
  writeDisclosureDraft,
} = require('../../src/core/disclosure-prep');

function makeItem(overrides = {}) {
  return {
    libraryName:        'lodash',
    currentVersion:     '4.17.15',
    recommendedVersion: '4.17.21',
    phase:              'C',
    highestSeverity:    'HIGH',
    libraryType:        'npm',
    cves: [
      { id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2 },
    ],
    ...overrides,
  };
}

// ─── buildDisclosureDraft ─────────────────────────────────────────────────────
describe('buildDisclosureDraft', () => {
  test('throws if item.libraryName is missing', () => {
    expect(() => buildDisclosureDraft({})).toThrow('item.libraryName required');
  });

  test('status is DRAFT', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.status).toBe(DISCLOSURE_STATUS.DRAFT);
  });

  test('requiresApproval is always true', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.requiresApproval).toBe(true);
  });

  test('autoSend is always false', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.autoSend).toBe(false);
  });

  test('captures pkgName, installedVersion, fixVersion', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.pkgName).toBe('lodash');
    expect(d.installedVersion).toBe('4.17.15');
    expect(d.fixVersion).toBe('4.17.21');
  });

  test('captures CVE list', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.cves).toHaveLength(1);
    expect(d.cves[0].id).toBe('CVE-2021-23337');
  });

  test('null fixVersion when recommendedVersion is absent', () => {
    const d = buildDisclosureDraft(makeItem({ recommendedVersion: undefined }));
    expect(d.fixVersion).toBeNull();
  });

  test('captures reporter info from opts', () => {
    const d = buildDisclosureDraft(makeItem(), {
      reporterName:  'Security Team',
      reporterEmail: 'security@example.com',
      repositoryUrl: 'https://github.com/lodash/lodash',
    });
    expect(d.reporterName).toBe('Security Team');
    expect(d.reporterEmail).toBe('security@example.com');
    expect(d.repositoryUrl).toBe('https://github.com/lodash/lodash');
  });

  test('includes warnings array', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(Array.isArray(d.warnings)).toBe(true);
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  test('timeline.reportedAt and resolvedAt start as null', () => {
    const d = buildDisclosureDraft(makeItem());
    expect(d.timeline.reportedAt).toBeNull();
    expect(d.timeline.resolvedAt).toBeNull();
  });
});

// ─── renderDisclosureDraft ────────────────────────────────────────────────────
describe('renderDisclosureDraft', () => {
  test('contains package name', () => {
    const d = buildDisclosureDraft(makeItem());
    const md = renderDisclosureDraft(d);
    expect(md).toContain('lodash');
  });

  test('contains CVE id', () => {
    const d = buildDisclosureDraft(makeItem());
    const md = renderDisclosureDraft(d);
    expect(md).toContain('CVE-2021-23337');
  });

  test('contains DO NOT SEND warning', () => {
    const d = buildDisclosureDraft(makeItem());
    const md = renderDisclosureDraft(d);
    expect(md).toMatch(/DO NOT SEND/i);
  });

  test('contains status header', () => {
    const d = buildDisclosureDraft(makeItem());
    const md = renderDisclosureDraft(d);
    expect(md).toContain('DRAFT');
  });

  test('contains repository URL when provided', () => {
    const d = buildDisclosureDraft(makeItem(), { repositoryUrl: 'https://github.com/lodash/lodash' });
    const md = renderDisclosureDraft(d);
    expect(md).toContain('https://github.com/lodash/lodash');
  });
});

// ─── writeDisclosureDraft ─────────────────────────────────────────────────────
describe('writeDisclosureDraft', () => {
  test('writes markdown and JSON files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclosure-test-'));
    try {
      const mdPath = writeDisclosureDraft(makeItem(), tmpDir);
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(mdPath).toMatch(/disclosure-lodash\.md$/);
      const jsonPath = mdPath.replace('.md', '.json');
      expect(fs.existsSync(jsonPath)).toBe(true);
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      expect(json.pkgName).toBe('lodash');
      expect(json.requiresApproval).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles scoped package name safely', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclosure-scoped-'));
    try {
      const item   = makeItem({ libraryName: '@babel/core' });
      const mdPath = writeDisclosureDraft(item, tmpDir);
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(path.basename(mdPath)).toMatch(/disclosure-babel_core\.md/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('creates outDir if it does not exist', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'disclosure-mkdir-'));
    const newDir  = path.join(tmpBase, 'sub');
    try {
      writeDisclosureDraft(makeItem(), newDir);
      expect(fs.existsSync(newDir)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
