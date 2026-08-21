'use strict';

const {
  SCHEMA_VERSION,
  OUTCOMES,
  EXPOSURE,
  createEvidence,
  mergeVerificationResult,
  mergeRescanResult,
  mergeExposureClassification,
  toSarif,
  toCycloneDxVex,
} = require('../../src/core/evidence-model');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    libraryName:       'lodash',
    currentVersion:    '4.17.11',
    recommendedVersion:'4.17.21',
    upgradeType:       'SAFE',
    phase:             'A',
    justification:     'Safe same-major patch upgrade',
    cves: [{ id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2, fixVersions: ['4.17.21'] }],
    depChain:          ['react', 'lodash'],
    rootParents:       [{ name: 'react', range: '^17.0.0', isDev: false }],
    probableFalsePositive: false,
    evidence:          'Same-major upgrade: 4.17.11 → 4.17.21',
    alternative:       '',
    ...overrides,
  };
}

const BASE_OPTS = { project: 'ui-platform', provider: 'mend', ecosystem: 'npm', generatedAt: '2026-08-21T00:00:00.000Z' };

// ─── Schema version ───────────────────────────────────────────────────────────

test('SCHEMA_VERSION is a non-empty string', () => {
  expect(typeof SCHEMA_VERSION).toBe('string');
  expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
});

// ─── Outcome taxonomy (M2.5) ─────────────────────────────────────────────────

test('OUTCOMES contains all 10 required values', () => {
  const required = [
    'FIXED', 'NOT_AFFECTED', 'MITIGATED', 'PATCHED', 'FORKED',
    'ACCEPTED_RISK', 'LICENSE_BLOCKED', 'VERIFICATION_FAILED',
    'REQUIRES_MIGRATION', 'NO_SAFE_PATH',
  ];
  for (const key of required) {
    expect(OUTCOMES[key]).toBe(key);
  }
});

test('OUTCOMES is frozen', () => {
  expect(Object.isFrozen(OUTCOMES)).toBe(true);
});

// ─── Exposure stubs (D1A) ────────────────────────────────────────────────────

test('EXPOSURE contains all 9 classification values', () => {
  const required = [
    'RUNTIME_REACHABLE', 'PRODUCTION_BUNDLED', 'BUILD_TIME_EXECUTED',
    'CI_EXECUTED', 'TEST_ONLY', 'LOCAL_TOOLING_ONLY', 'INSTALLED_NOT_USED',
    'NOT_IN_PRODUCTION_ARTIFACT', 'UNKNOWN_EXPOSURE',
  ];
  for (const key of required) {
    expect(EXPOSURE[key]).toBe(key);
  }
});

test('EXPOSURE is frozen', () => {
  expect(Object.isFrozen(EXPOSURE)).toBe(true);
});

// ─── createEvidence — structure ───────────────────────────────────────────────

test('createEvidence returns an object with required top-level fields', () => {
  const bundle = createEvidence(makeItem(), BASE_OPTS);
  expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
  expect(bundle.libraryName).toBe('lodash');
  expect(bundle.currentVersion).toBe('4.17.11');
  expect(bundle.fixVersion).toBe('4.17.21');
  expect(bundle.phase).toBe('A');
  expect(bundle.ecosystem).toBe('npm');
  expect(bundle.provider).toBe('mend');
  expect(bundle.project).toBe('ui-platform');
  expect(bundle.generatedAt).toBe('2026-08-21T00:00:00.000Z');
});

test('createEvidence Phase A SAFE → outcome FIXED', () => {
  expect(createEvidence(makeItem()).outcome).toBe(OUTCOMES.FIXED);
});

test('createEvidence MAJOR_BUMP → outcome REQUIRES_MIGRATION', () => {
  const bundle = createEvidence(makeItem({ upgradeType: 'MAJOR_BUMP', phase: 'C', recommendedVersion: '5.0.0' }));
  expect(bundle.outcome).toBe(OUTCOMES.REQUIRES_MIGRATION);
});

test('createEvidence NO_FIX non-false-positive → outcome NO_SAFE_PATH', () => {
  const bundle = createEvidence(makeItem({ upgradeType: 'NO_FIX', phase: 'C', recommendedVersion: null }));
  expect(bundle.outcome).toBe(OUTCOMES.NO_SAFE_PATH);
});

test('createEvidence NO_FIX false-positive → outcome NOT_AFFECTED', () => {
  const bundle = createEvidence(makeItem({
    upgradeType: 'NO_FIX', phase: 'C', recommendedVersion: null, probableFalsePositive: true,
  }));
  expect(bundle.outcome).toBe(OUTCOMES.NOT_AFFECTED);
});

test('createEvidence CVEs mapped correctly', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.cves).toHaveLength(1);
  expect(bundle.cves[0]).toEqual({ id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2 });
});

test('createEvidence semver block populated', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.semver.upgradeType).toBe('SAFE');
  expect(bundle.semver.rangeViolation).toBeNull();
  expect(bundle.semver.registryAdjusted).toBe(false);
});

test('createEvidence semver.rangeViolation populated when present', () => {
  const bundle = createEvidence(makeItem({
    phase: 'B',
    rangeViolation: { consumer: 'react', range: '~4.17.0' },
  }));
  expect(bundle.semver.rangeViolation).toEqual({ consumer: 'react', range: '~4.17.0' });
});

test('createEvidence lockFile block carries depChain and rootParents', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.lockFile.depChain).toEqual(['react', 'lodash']);
  expect(bundle.lockFile.rootParents).toHaveLength(1);
  expect(bundle.lockFile.probableFalsePositive).toBe(false);
});

test('createEvidence exposure starts as UNKNOWN_EXPOSURE', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.exposure.classification).toBe(EXPOSURE.UNKNOWN_EXPOSURE);
  expect(bundle.exposure.confidence).toBeNull();
});

test('createEvidence verification and rescan are null initially', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.verification).toBeNull();
  expect(bundle.rescan).toBeNull();
});

test('createEvidence carries humanEvidence and humanAlternative', () => {
  const bundle = createEvidence(makeItem());
  expect(bundle.humanEvidence).toBe('Same-major upgrade: 4.17.11 → 4.17.21');
});

test('createEvidence accepts item with no cves gracefully', () => {
  const bundle = createEvidence(makeItem({ cves: undefined }));
  expect(bundle.cves).toEqual([]);
});

test('createEvidence accepts item with no depChain gracefully', () => {
  const bundle = createEvidence(makeItem({ depChain: undefined, rootParents: undefined }));
  expect(bundle.lockFile.depChain).toEqual([]);
  expect(bundle.lockFile.rootParents).toEqual([]);
});

test('createEvidence does not mutate the original item', () => {
  const item = makeItem();
  createEvidence(item);
  expect(item.schemaVersion).toBeUndefined();
});

// ─── mergeVerificationResult ─────────────────────────────────────────────────

test('mergeVerificationResult passed=true keeps outcome FIXED', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'], durationMs: 4200 });
  expect(merged.outcome).toBe(OUTCOMES.FIXED);
  expect(merged.verification.passed).toBe(true);
  expect(merged.verification.commands).toEqual(['npm test']);
  expect(merged.verification.durationMs).toBe(4200);
});

test('mergeVerificationResult passed=false → VERIFICATION_FAILED', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeVerificationResult(bundle, {
    passed: false, commands: ['npm test'], durationMs: 1500, failureReason: 'Test suite failed',
  });
  expect(merged.outcome).toBe(OUTCOMES.VERIFICATION_FAILED);
  expect(merged.verification.failureReason).toBe('Test suite failed');
});

test('mergeVerificationResult does not mutate original bundle', () => {
  const bundle = createEvidence(makeItem());
  mergeVerificationResult(bundle, { passed: true, commands: [] });
  expect(bundle.verification).toBeNull();
});

test('mergeVerificationResult sets ranAt when provided', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeVerificationResult(bundle, { passed: true, commands: [], ranAt: '2026-08-21T10:00:00.000Z' });
  expect(merged.verification.ranAt).toBe('2026-08-21T10:00:00.000Z');
});

// ─── mergeRescanResult ────────────────────────────────────────────────────────

test('mergeRescanResult RESOLVED_AND_RESCANNED with no remaining CVEs keeps FIXED', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeRescanResult(bundle, { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: [] });
  expect(merged.outcome).toBe(OUTCOMES.FIXED);
  expect(merged.rescan.status).toBe('RESOLVED_AND_RESCANNED');
});

test('mergeRescanResult RESOLVED_NOT_RESCANNED keeps original outcome', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeRescanResult(bundle, { status: 'RESOLVED_NOT_RESCANNED' });
  expect(merged.outcome).toBe(OUTCOMES.FIXED);
  expect(merged.rescan.status).toBe('RESOLVED_NOT_RESCANNED');
});

test('mergeRescanResult with remaining CVEs → VERIFICATION_FAILED', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeRescanResult(bundle, {
    status: 'RESOLVED_AND_RESCANNED',
    remainingCveIds: ['CVE-2021-23337'],
  });
  expect(merged.outcome).toBe(OUTCOMES.VERIFICATION_FAILED);
  expect(merged.rescan.remainingCveIds).toEqual(['CVE-2021-23337']);
});

test('mergeRescanResult VERIFICATION_FAILED status → VERIFICATION_FAILED outcome', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeRescanResult(bundle, { status: 'VERIFICATION_FAILED', remainingCveIds: [] });
  expect(merged.outcome).toBe(OUTCOMES.VERIFICATION_FAILED);
});

test('mergeRescanResult does not mutate original bundle', () => {
  const bundle = createEvidence(makeItem());
  mergeRescanResult(bundle, { status: 'INSTALL_VERIFIED_ONLY' });
  expect(bundle.rescan).toBeNull();
});

// ─── mergeExposureClassification ─────────────────────────────────────────────

test('mergeExposureClassification sets exposure fields', () => {
  const bundle = createEvidence(makeItem());
  const merged = mergeExposureClassification(bundle, {
    classification:  EXPOSURE.TEST_ONLY,
    confidence:      0.9,
    evidenceSources: ['devDependency flag', 'no production bundle'],
  });
  expect(merged.exposure.classification).toBe(EXPOSURE.TEST_ONLY);
  expect(merged.exposure.confidence).toBe(0.9);
  expect(merged.exposure.evidenceSources).toHaveLength(2);
});

test('mergeExposureClassification does not mutate original bundle', () => {
  const bundle = createEvidence(makeItem());
  mergeExposureClassification(bundle, { classification: EXPOSURE.RUNTIME_REACHABLE, confidence: 0.8, evidenceSources: [] });
  expect(bundle.exposure.classification).toBe(EXPOSURE.UNKNOWN_EXPOSURE);
});

// ─── toSarif ─────────────────────────────────────────────────────────────────

test('toSarif produces valid SARIF 2.1.0 skeleton', () => {
  const bundle = createEvidence(makeItem(), BASE_OPTS);
  const sarif  = toSarif([bundle], { toolName: 'mend-autofixer', toolVersion: '0.1.0' });
  expect(sarif.version).toBe('2.1.0');
  expect(sarif.runs).toHaveLength(1);
  expect(sarif.runs[0].tool.driver.name).toBe('mend-autofixer');
  expect(sarif.runs[0].results).toHaveLength(1);
});

test('toSarif result level is "error" for HIGH severity', () => {
  const bundle = createEvidence(makeItem());
  const sarif  = toSarif([bundle]);
  expect(sarif.runs[0].results[0].level).toBe('error');
});

test('toSarif result level is "warning" for MEDIUM severity', () => {
  const bundle = createEvidence(makeItem({
    cves: [{ id: 'CVE-2021-00001', severity: 'MEDIUM', score: 5.0, fixVersions: [] }],
  }));
  const sarif = toSarif([bundle]);
  expect(sarif.runs[0].results[0].level).toBe('warning');
});

test('toSarif deduplicates rules across multiple bundles sharing a CVE', () => {
  const b1 = createEvidence(makeItem());
  const b2 = createEvidence(makeItem({ libraryName: 'underscore', currentVersion: '1.9.0' }));
  const sarif = toSarif([b1, b2]);
  const rules = sarif.runs[0].tool.driver.rules;
  const ids   = rules.map(r => r.id);
  expect(new Set(ids).size).toBe(ids.length); // no duplicates
});

test('toSarif result properties include phase and outcome', () => {
  const bundle = createEvidence(makeItem());
  const result = toSarif([bundle]).runs[0].results[0];
  expect(result.properties.phase).toBe('A');
  expect(result.properties.outcome).toBe(OUTCOMES.FIXED);
});

test('toSarif handles bundle with no CVEs', () => {
  const bundle = createEvidence(makeItem({ cves: [] }));
  const sarif  = toSarif([bundle]);
  expect(sarif.runs[0].results).toHaveLength(1);
  expect(sarif.runs[0].results[0].ruleId).toContain('lodash');
});

// ─── toCycloneDxVex ───────────────────────────────────────────────────────────

test('toCycloneDxVex produces CycloneDX 1.5 VEX skeleton', () => {
  const bundle = createEvidence(makeItem(), BASE_OPTS);
  const vex    = toCycloneDxVex([bundle], { component: 'ui-platform' });
  expect(vex.bomFormat).toBe('CycloneDX');
  expect(vex.specVersion).toBe('1.5');
  expect(vex.vulnerabilities).toHaveLength(1);
});

test('toCycloneDxVex FIXED outcome maps to state "resolved"', () => {
  const bundle = createEvidence(makeItem());
  const vex    = toCycloneDxVex([bundle]);
  expect(vex.vulnerabilities[0].analysis.state).toBe('resolved');
});

test('toCycloneDxVex NO_SAFE_PATH maps to state "in_triage"', () => {
  const bundle = createEvidence(makeItem({ upgradeType: 'NO_FIX', phase: 'C', recommendedVersion: null }));
  const vex    = toCycloneDxVex([bundle]);
  expect(vex.vulnerabilities[0].analysis.state).toBe('in_triage');
});

test('toCycloneDxVex NOT_AFFECTED maps to state "not_affected"', () => {
  const bundle = createEvidence(makeItem({
    upgradeType: 'NO_FIX', phase: 'C', recommendedVersion: null, probableFalsePositive: true,
  }));
  const vex = toCycloneDxVex([bundle]);
  expect(vex.vulnerabilities[0].analysis.state).toBe('not_affected');
});

test('toCycloneDxVex affects ref includes package name and version', () => {
  const bundle = createEvidence(makeItem(), BASE_OPTS);
  const vex    = toCycloneDxVex([bundle]);
  expect(vex.vulnerabilities[0].affects[0].ref).toContain('lodash');
  expect(vex.vulnerabilities[0].affects[0].ref).toContain('4.17.11');
});

test('toCycloneDxVex properties contain phase and outcome', () => {
  const bundle = createEvidence(makeItem());
  const props  = toCycloneDxVex([bundle]).vulnerabilities[0].properties;
  const phaseP = props.find(p => p.name === 'phase');
  const outP   = props.find(p => p.name === 'outcome');
  expect(phaseP.value).toBe('A');
  expect(outP.value).toBe(OUTCOMES.FIXED);
});

test('toCycloneDxVex multiple CVEs on one package produce multiple vulnerability entries', () => {
  const bundle = createEvidence(makeItem({
    cves: [
      { id: 'CVE-2021-23337', severity: 'HIGH', score: 7.2 },
      { id: 'CVE-2020-28500', severity: 'MEDIUM', score: 5.3 },
    ],
  }));
  const vex = toCycloneDxVex([bundle]);
  expect(vex.vulnerabilities).toHaveLength(2);
});

// ─── Round-trip: create → merge verification → merge rescan ──────────────────

test('full pipeline: create → verify pass → rescan resolved → outcome stays FIXED', () => {
  let bundle = createEvidence(makeItem(), BASE_OPTS);
  bundle = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'], durationMs: 3000 });
  bundle = mergeRescanResult(bundle, { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: [] });
  expect(bundle.outcome).toBe(OUTCOMES.FIXED);
  expect(bundle.verification.passed).toBe(true);
  expect(bundle.rescan.status).toBe('RESOLVED_AND_RESCANNED');
});

test('full pipeline: create → verify fail → outcome VERIFICATION_FAILED', () => {
  let bundle = createEvidence(makeItem(), BASE_OPTS);
  bundle = mergeVerificationResult(bundle, { passed: false, commands: ['npm test'], failureReason: 'build error' });
  expect(bundle.outcome).toBe(OUTCOMES.VERIFICATION_FAILED);
});

test('full pipeline: create → verify pass → rescan finds remaining CVEs → VERIFICATION_FAILED', () => {
  let bundle = createEvidence(makeItem(), BASE_OPTS);
  bundle = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'] });
  bundle = mergeRescanResult(bundle, { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: ['CVE-2021-23337'] });
  expect(bundle.outcome).toBe(OUTCOMES.VERIFICATION_FAILED);
});
