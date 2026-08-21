'use strict';

const {
  RESCAN_STATUS,
  classifyRescanOutcome,
  classifyPlanRescanOutcomes,
} = require('../../src/core/rescan-adapter');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    libraryName: 'lodash',
    currentVersion: '4.17.11',
    cves: [
      { id: 'CVE-2021-23337', severity: 'HIGH' },
      { id: 'CVE-2020-28500', severity: 'MEDIUM' },
    ],
    phase: 'A',
    ...overrides,
  };
}

// Library entries as they would come from a post-remediation rescan
function makeEntry(libraryName, cveIds) {
  return {
    libraryName,
    cves: cveIds.map(id => ({ id, severity: 'HIGH' })),
  };
}

// ─── RESCAN_STATUS constants ──────────────────────────────────────────────────

test('RESCAN_STATUS contains all 4 required values', () => {
  const required = ['RESOLVED_AND_RESCANNED', 'RESOLVED_NOT_RESCANNED', 'INSTALL_VERIFIED_ONLY', 'VERIFICATION_FAILED'];
  for (const key of required) expect(RESCAN_STATUS[key]).toBe(key);
});

test('RESCAN_STATUS is frozen', () => {
  expect(Object.isFrozen(RESCAN_STATUS)).toBe(true);
});

// ─── No rescan (afterEntries=null) ────────────────────────────────────────────

test('null afterEntries → RESOLVED_NOT_RESCANNED', () => {
  const result = classifyRescanOutcome(makeItem(), null);
  expect(result.status).toBe(RESCAN_STATUS.RESOLVED_NOT_RESCANNED);
  expect(result.remainingCveIds).toEqual([]);
  expect(result.resolvedCveIds).toEqual([]);
});

test('undefined afterEntries → RESOLVED_NOT_RESCANNED', () => {
  const result = classifyRescanOutcome(makeItem(), undefined);
  expect(result.status).toBe(RESCAN_STATUS.RESOLVED_NOT_RESCANNED);
});

// ─── No CVEs on item ─────────────────────────────────────────────────────────

test('item with no cves + after-entries → INSTALL_VERIFIED_ONLY', () => {
  const result = classifyRescanOutcome(makeItem({ cves: [] }), []);
  expect(result.status).toBe(RESCAN_STATUS.INSTALL_VERIFIED_ONLY);
});

test('item with undefined cves → INSTALL_VERIFIED_ONLY', () => {
  const result = classifyRescanOutcome(makeItem({ cves: undefined }), []);
  expect(result.status).toBe(RESCAN_STATUS.INSTALL_VERIFIED_ONLY);
});

// ─── All CVEs resolved ────────────────────────────────────────────────────────

test('rescan finds no remaining CVEs → RESOLVED_AND_RESCANNED', () => {
  const after  = [makeEntry('other-pkg', ['CVE-9999-99999'])]; // lodash clean
  const result = classifyRescanOutcome(makeItem(), after);
  expect(result.status).toBe(RESCAN_STATUS.RESOLVED_AND_RESCANNED);
  expect(result.remainingCveIds).toEqual([]);
  expect(result.resolvedCveIds).toEqual(expect.arrayContaining(['CVE-2021-23337', 'CVE-2020-28500']));
});

test('empty after-entries array → RESOLVED_AND_RESCANNED', () => {
  const result = classifyRescanOutcome(makeItem(), []);
  expect(result.status).toBe(RESCAN_STATUS.RESOLVED_AND_RESCANNED);
  expect(result.remainingCveIds).toEqual([]);
});

// ─── Some CVEs remain ────────────────────────────────────────────────────────

test('one CVE still present → VERIFICATION_FAILED', () => {
  const after  = [makeEntry('lodash', ['CVE-2021-23337'])]; // one still open
  const result = classifyRescanOutcome(makeItem(), after);
  expect(result.status).toBe(RESCAN_STATUS.VERIFICATION_FAILED);
  expect(result.remainingCveIds).toEqual(['CVE-2021-23337']);
  expect(result.resolvedCveIds).toEqual(['CVE-2020-28500']);
});

test('all CVEs still present → VERIFICATION_FAILED with full remainingCveIds', () => {
  const after  = [makeEntry('lodash', ['CVE-2021-23337', 'CVE-2020-28500'])];
  const result = classifyRescanOutcome(makeItem(), after);
  expect(result.status).toBe(RESCAN_STATUS.VERIFICATION_FAILED);
  expect(result.remainingCveIds).toHaveLength(2);
  expect(result.resolvedCveIds).toHaveLength(0);
});

// ─── CVEs from other packages ignored ────────────────────────────────────────

test('CVEs from other packages do not affect lodash result', () => {
  const after  = [makeEntry('other-pkg', ['CVE-2021-23337'])]; // same CVE id but different pkg
  const result = classifyRescanOutcome(makeItem(), after);
  // The CVE is on 'other-pkg', not 'lodash', so lodash is clean
  expect(result.status).toBe(RESCAN_STATUS.RESOLVED_AND_RESCANNED);
});

// ─── ranAt and rescanReportFile ───────────────────────────────────────────────

test('result includes ranAt string', () => {
  const result = classifyRescanOutcome(makeItem(), null);
  expect(typeof result.ranAt).toBe('string');
});

test('rescanReportFile passed through from opts', () => {
  const result = classifyRescanOutcome(makeItem(), [], { rescanReportFile: '/out/rescan.json' });
  expect(result.rescanReportFile).toBe('/out/rescan.json');
});

test('rescanReportFile defaults to null', () => {
  const result = classifyRescanOutcome(makeItem(), []);
  expect(result.rescanReportFile).toBeNull();
});

// ─── classifyPlanRescanOutcomes ───────────────────────────────────────────────

test('classifyPlanRescanOutcomes returns parallel array', () => {
  const plan = [makeItem(), makeItem({ libraryName: 'axios', cves: [{ id: 'CVE-2023-45857' }] })];
  const results = classifyPlanRescanOutcomes(plan, null);
  expect(results).toHaveLength(2);
  expect(results[0].status).toBe(RESCAN_STATUS.RESOLVED_NOT_RESCANNED);
  expect(results[1].status).toBe(RESCAN_STATUS.RESOLVED_NOT_RESCANNED);
});

test('classifyPlanRescanOutcomes with after-entries: resolved pkg passes, remaining pkg fails', () => {
  const plan  = [
    makeItem({ libraryName: 'lodash',  cves: [{ id: 'CVE-2021-23337' }] }),
    makeItem({ libraryName: 'axios',   cves: [{ id: 'CVE-2023-45857' }] }),
  ];
  const after = [
    makeEntry('axios', ['CVE-2023-45857']), // axios CVE still present
  ];
  const results = classifyPlanRescanOutcomes(plan, after);
  expect(results[0].status).toBe(RESCAN_STATUS.RESOLVED_AND_RESCANNED); // lodash clean
  expect(results[1].status).toBe(RESCAN_STATUS.VERIFICATION_FAILED);    // axios still open
});
