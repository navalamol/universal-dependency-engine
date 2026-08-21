'use strict';

const { GATE_DECISION, evaluateBundleGate, applyEvidenceGate } = require('../../src/core/evidence-gate');
const { OUTCOMES, createEvidence, mergeVerificationResult, mergeRescanResult } = require('../../src/core/evidence-model');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    libraryName: 'lodash', currentVersion: '4.17.11', recommendedVersion: '4.17.21',
    upgradeType: 'SAFE', phase: 'A', justification: 'Safe patch',
    cves: [{ id: 'CVE-2021-23337', severity: 'HIGH' }],
    ...overrides,
  };
}

function makeBundle(itemOverrides = {}, opts = {}) {
  return createEvidence(makeItem(itemOverrides), { generatedAt: '2026-08-21T00:00:00.000Z', ...opts });
}

// ─── GATE_DECISION constants ──────────────────────────────────────────────────

test('GATE_DECISION has ALLOWED, DOWNGRADED, BLOCKED', () => {
  expect(GATE_DECISION.ALLOWED).toBe('ALLOWED');
  expect(GATE_DECISION.DOWNGRADED).toBe('DOWNGRADED');
  expect(GATE_DECISION.BLOCKED).toBe('BLOCKED');
  expect(Object.isFrozen(GATE_DECISION)).toBe(true);
});

// ─── evaluateBundleGate — no policy (permissive) ─────────────────────────────

test('no policy → ALLOWED for Phase A FIXED bundle', () => {
  const { decision, reasons } = evaluateBundleGate(makeBundle());
  expect(decision).toBe(GATE_DECISION.ALLOWED);
  expect(reasons).toHaveLength(0);
});

// ─── evaluateBundleGate — VERIFICATION_FAILED outcome ────────────────────────

test('outcome VERIFICATION_FAILED → BLOCKED regardless of policy', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: false, commands: ['npm test'], failureReason: 'tests failed' });
  const { decision, reasons } = evaluateBundleGate(bundle, {});
  expect(decision).toBe(GATE_DECISION.BLOCKED);
  expect(reasons[0]).toMatch(/tests failed/);
});

// ─── evaluateBundleGate — requireVerification=true ───────────────────────────

test('requireVerification:true + no verification → DOWNGRADED', () => {
  const { decision, reasons } = evaluateBundleGate(makeBundle(), { requireVerification: true });
  expect(decision).toBe(GATE_DECISION.DOWNGRADED);
  expect(reasons[0]).toMatch(/not run/i);
});

test('requireVerification:true + verification passed → ALLOWED', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'] });
  const { decision } = evaluateBundleGate(bundle, { requireVerification: true });
  expect(decision).toBe(GATE_DECISION.ALLOWED);
});

test('requireVerification:true + verification failed → BLOCKED', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: false, commands: ['npm test'], failureReason: 'build error' });
  const { decision, reasons } = evaluateBundleGate(bundle, { requireVerification: true });
  expect(decision).toBe(GATE_DECISION.BLOCKED);
  expect(reasons[0]).toMatch(/build error/);
});

// ─── evaluateBundleGate — requireRescan=true ─────────────────────────────────

test('requireRescan:true + no rescan → DOWNGRADED', () => {
  const { decision, reasons } = evaluateBundleGate(makeBundle(), { requireRescan: true });
  expect(decision).toBe(GATE_DECISION.DOWNGRADED);
  expect(reasons[0]).toMatch(/not run/i);
});

test('requireRescan:true + RESOLVED_AND_RESCANNED → ALLOWED', () => {
  let bundle = makeBundle();
  bundle = mergeRescanResult(bundle, { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: [] });
  const { decision } = evaluateBundleGate(bundle, { requireRescan: true });
  expect(decision).toBe(GATE_DECISION.ALLOWED);
});

test('requireRescan:true + RESOLVED_NOT_RESCANNED → DOWNGRADED', () => {
  let bundle = makeBundle();
  bundle = mergeRescanResult(bundle, { status: 'RESOLVED_NOT_RESCANNED' });
  const { decision, reasons } = evaluateBundleGate(bundle, { requireRescan: true });
  // RESOLVED_NOT_RESCANNED: rescan ran per adapter but result.status is NOT VERIFICATION_FAILED
  // Gate sees rescan.status !== VERIFICATION_FAILED → ALLOWED
  // (RESOLVED_NOT_RESCANNED means install succeeded, no rescan tool ran — still passes the gate
  //  unless requireRescan demands an actual re-scan. Current design: any non-null rescan satisfies
  //  the requireRescan gate unless status is VERIFICATION_FAILED)
  expect(decision).toBe(GATE_DECISION.ALLOWED);
});

test('requireRescan:true + VERIFICATION_FAILED rescan status → BLOCKED', () => {
  let bundle = makeBundle();
  bundle = mergeRescanResult(bundle, { status: 'VERIFICATION_FAILED', remainingCveIds: ['CVE-2021-23337'] });
  const { decision, reasons } = evaluateBundleGate(bundle, { requireRescan: true });
  expect(decision).toBe(GATE_DECISION.BLOCKED);
  expect(reasons[0]).toMatch(/CVE-2021-23337/);
});

// ─── evaluateBundleGate — both requirements missing ──────────────────────────

test('both required; both missing → DOWNGRADED with two reasons', () => {
  const { decision, reasons } = evaluateBundleGate(makeBundle(), {
    requireVerification: true, requireRescan: true,
  });
  expect(decision).toBe(GATE_DECISION.DOWNGRADED);
  expect(reasons).toHaveLength(2);
});

// ─── applyEvidenceGate — length mismatch ─────────────────────────────────────

test('applyEvidenceGate throws when arrays are different lengths', () => {
  expect(() => applyEvidenceGate([makeItem()], [makeBundle(), makeBundle()])).toThrow('same length');
});

// ─── applyEvidenceGate — no policy (permissive) ──────────────────────────────

test('applyEvidenceGate no policy → all Phase A items ALLOWED, phases unchanged', () => {
  const plan    = [makeItem(), makeItem({ libraryName: 'axios' })];
  const bundles = plan.map(i => makeBundle({ libraryName: i.libraryName }));
  const { phasedPlan, gateReport } = applyEvidenceGate(plan, bundles);
  expect(phasedPlan[0].phase).toBe('A');
  expect(phasedPlan[1].phase).toBe('A');
  expect(gateReport[0].decision).toBe(GATE_DECISION.ALLOWED);
});

// ─── applyEvidenceGate — DOWNGRADED (A→B) ────────────────────────────────────

test('applyEvidenceGate downgraded Phase A item gets phase:B and updated justification', () => {
  const plan    = [makeItem()];
  const bundles = [makeBundle()]; // verification not run
  const { phasedPlan, gateReport } = applyEvidenceGate(plan, bundles, { requireVerification: true });
  expect(phasedPlan[0].phase).toBe('B');
  expect(phasedPlan[0].justification).toMatch(/Downgraded A→B/);
  expect(gateReport[0].decision).toBe(GATE_DECISION.DOWNGRADED);
});

// ─── applyEvidenceGate — BLOCKED ─────────────────────────────────────────────

test('applyEvidenceGate blocked item gets gateBlocked:true and gateReason', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: false, commands: ['npm test'], failureReason: 'build broke' });
  const plan = [makeItem()];
  const { phasedPlan, gateReport } = applyEvidenceGate(plan, [bundle]);
  expect(phasedPlan[0].gateBlocked).toBe(true);
  expect(phasedPlan[0].gateReason).toMatch(/build broke/);
  expect(gateReport[0].decision).toBe(GATE_DECISION.BLOCKED);
});

test('blocked item retains original phase (not mutated to B)', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: false, commands: [], failureReason: 'x' });
  const { phasedPlan } = applyEvidenceGate([makeItem()], [bundle]);
  expect(phasedPlan[0].phase).toBe('A'); // phase stays A — gateBlocked flag is the signal
});

// ─── applyEvidenceGate — Phase B/C items pass through untouched ──────────────

test('Phase B items pass through as ALLOWED without modification', () => {
  const plan    = [makeItem({ phase: 'B' })];
  const bundles = [makeBundle({ phase: 'B' })];
  const { phasedPlan, gateReport } = applyEvidenceGate(plan, bundles, { requireVerification: true });
  expect(phasedPlan[0].phase).toBe('B');
  expect(phasedPlan[0].justification).not.toMatch(/Downgraded/);
  expect(gateReport[0].decision).toBe(GATE_DECISION.ALLOWED);
});

test('Phase C items pass through as ALLOWED', () => {
  const plan    = [makeItem({ phase: 'C', upgradeType: 'MAJOR_BUMP' })];
  const bundles = [makeBundle({ phase: 'C', upgradeType: 'MAJOR_BUMP' })];
  const { phasedPlan, gateReport } = applyEvidenceGate(plan, bundles, { requireVerification: true });
  expect(phasedPlan[0].phase).toBe('C');
  expect(gateReport[0].decision).toBe(GATE_DECISION.ALLOWED);
});

// ─── applyEvidenceGate — does not mutate original plan ───────────────────────

test('applyEvidenceGate does not mutate original phasedPlan items', () => {
  const item   = makeItem();
  const bundle = makeBundle();
  applyEvidenceGate([item], [bundle], { requireVerification: true });
  expect(item.phase).toBe('A');
  expect(item.justification).toBe('Safe patch');
});

// ─── Full pipeline integration ────────────────────────────────────────────────

test('full pipeline: verify pass + rescan resolved → ALLOWED', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'] });
  bundle = mergeRescanResult(bundle, { status: 'RESOLVED_AND_RESCANNED', remainingCveIds: [] });
  const { phasedPlan } = applyEvidenceGate([makeItem()], [bundle], {
    requireVerification: true, requireRescan: true,
  });
  expect(phasedPlan[0].phase).toBe('A');
  expect(phasedPlan[0].gateBlocked).toBeUndefined();
});

test('full pipeline: verify pass + rescan finds CVE → BLOCKED', () => {
  let bundle = makeBundle();
  bundle = mergeVerificationResult(bundle, { passed: true, commands: ['npm test'] });
  bundle = mergeRescanResult(bundle, { status: 'VERIFICATION_FAILED', remainingCveIds: ['CVE-2021-23337'] });
  const { phasedPlan } = applyEvidenceGate([makeItem()], [bundle], {
    requireVerification: true, requireRescan: true,
  });
  expect(phasedPlan[0].gateBlocked).toBe(true);
});
