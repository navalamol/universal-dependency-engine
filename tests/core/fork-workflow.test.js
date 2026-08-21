'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const {
  FORK_STATUS,
  FORK_REASON,
  createForkSpec,
  buildForkDebtLedger,
  writeForkDebtLedger,
} = require('../../src/core/fork-workflow');

function makeItem(overrides = {}) {
  return {
    libraryName:        'lodash',
    currentVersion:     '4.17.15',
    recommendedVersion: '4.17.21',
    phase:              'C',
    cves:               [{ id: 'CVE-2021-23337' }],
    ...overrides,
  };
}

// ─── createForkSpec ───────────────────────────────────────────────────────────
describe('createForkSpec', () => {
  test('creates a valid spec with scoped name', () => {
    const spec = createForkSpec(makeItem(), 'myorg');
    expect(spec.scopedName).toBe('@myorg/lodash');
    expect(spec.originalPackage).toBe('lodash');
    expect(spec.status).toBe(FORK_STATUS.ACTIVE);
    expect(spec.reason).toBe(FORK_REASON.NO_UPSTREAM_FIX);
    expect(spec.cves).toEqual(['CVE-2021-23337']);
  });

  test('strips existing scope from package name', () => {
    const spec = createForkSpec(makeItem({ libraryName: '@babel/core' }), 'myorg');
    expect(spec.scopedName).toBe('@myorg/core');
    expect(spec.originalPackage).toBe('@babel/core');
  });

  test('uses custom owner and reason', () => {
    const spec = createForkSpec(makeItem(), 'acme', {
      owner:  'alice@example.com',
      reason: FORK_REASON.EMERGENCY_PATCH,
    });
    expect(spec.owner).toBe('alice@example.com');
    expect(spec.reason).toBe(FORK_REASON.EMERGENCY_PATCH);
  });

  test('expiry is expiryDays after createdAt', () => {
    const createdAt = '2024-01-01T00:00:00.000Z';
    const spec = createForkSpec(makeItem(), 'org', { expiryDays: 30, createdAt });
    const diff = new Date(spec.expiresAt) - new Date(spec.createdAt);
    expect(diff).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('throws if item.libraryName is missing', () => {
    expect(() => createForkSpec({}, 'org')).toThrow('item.libraryName required');
  });

  test('throws if org is missing', () => {
    expect(() => createForkSpec(makeItem(), '')).toThrow('org (npm scope) required');
  });

  test('captures phase from item', () => {
    const spec = createForkSpec(makeItem({ phase: 'B' }), 'org');
    expect(spec.phase).toBe('B');
  });
});

// ─── buildForkDebtLedger ──────────────────────────────────────────────────────
describe('buildForkDebtLedger', () => {
  test('returns correct totals for all-active specs', () => {
    const future = new Date(Date.now() + 1e9).toISOString();
    const specs  = [
      { ...createForkSpec(makeItem(), 'org'), expiresAt: future },
      { ...createForkSpec(makeItem({ libraryName: 'moment' }), 'org'), expiresAt: future },
    ];
    const ledger = buildForkDebtLedger(specs);
    expect(ledger.totalForks).toBe(2);
    expect(ledger.active).toBe(2);
    expect(ledger.expired).toBe(0);
  });

  test('marks ACTIVE spec past expiry as EXPIRED', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const spec  = { ...createForkSpec(makeItem(), 'org'), expiresAt: past };
    const ledger = buildForkDebtLedger([spec]);
    expect(ledger.expired).toBe(1);
    expect(ledger.active).toBe(0);
    expect(ledger.entries[0].status).toBe(FORK_STATUS.EXPIRED);
  });

  test('does not change RESOLVED spec status', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const spec  = { ...createForkSpec(makeItem(), 'org'), expiresAt: past, status: FORK_STATUS.RESOLVED };
    const ledger = buildForkDebtLedger([spec]);
    expect(ledger.entries[0].status).toBe(FORK_STATUS.RESOLVED);
    expect(ledger.resolved).toBe(1);
    expect(ledger.expired).toBe(0);
  });

  test('handles empty specs array', () => {
    const ledger = buildForkDebtLedger([]);
    expect(ledger.totalForks).toBe(0);
    expect(ledger.entries).toEqual([]);
  });

  test('respects custom now for expiry comparison', () => {
    const spec   = createForkSpec(makeItem(), 'org', { createdAt: '2024-01-01T00:00:00.000Z', expiryDays: 30 });
    const ledger = buildForkDebtLedger([spec], { now: '2025-01-01T00:00:00.000Z' });
    expect(ledger.entries[0].status).toBe(FORK_STATUS.EXPIRED);
  });
});

// ─── writeForkDebtLedger ──────────────────────────────────────────────────────
describe('writeForkDebtLedger', () => {
  test('writes markdown and JSON files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ledger-test-'));
    try {
      const spec   = createForkSpec(makeItem(), 'org');
      const ledger = buildForkDebtLedger([spec]);
      const mdPath = writeForkDebtLedger(ledger, tmpDir);
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(mdPath).toContain('fork-debt-ledger.md');
      const jsonPath = path.join(tmpDir, 'fork-debt-ledger.json');
      expect(fs.existsSync(jsonPath)).toBe(true);
      const md = fs.readFileSync(mdPath, 'utf8');
      expect(md).toContain('Fork Debt Ledger');
      expect(md).toContain('@org/lodash');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('includes expiry warning when expired forks exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-warn-test-'));
    try {
      const past   = new Date(Date.now() - 1000).toISOString();
      const spec   = { ...createForkSpec(makeItem(), 'org'), expiresAt: past };
      const ledger = buildForkDebtLedger([spec]);
      const mdPath = writeForkDebtLedger(ledger, tmpDir);
      const md     = fs.readFileSync(mdPath, 'utf8');
      expect(md).toContain('Warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('creates outDir if it does not exist', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-mkdir-test-'));
    const newDir  = path.join(tmpBase, 'sub');
    try {
      const ledger = buildForkDebtLedger([]);
      writeForkDebtLedger(ledger, newDir);
      expect(fs.existsSync(newDir)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
