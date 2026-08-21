'use strict';

// M3.4 — Pilot KPI report generator.
// Computes metrics from EvidenceBundle[] and generates a markdown report.
//
// Metrics (all measured from evidence bundles — never fabricated):
//   - totalFindings         — count of bundles
//   - phaseDistribution     — {A, B, C} exact counts
//   - outcomeDistribution   — per-outcome counts
//   - remediatedCount       — bundles with outcome FIXED
//   - verificationPassRate  — passed / total_ran (null if none ran)
//   - rescanClosureRate     — RESOLVED_AND_RESCANNED / total_rescanned (null if none ran)
//   - exposureBreakdown     — per-classification counts from exposure field
//   - runtimeReachableDelta — count of RUNTIME_REACHABLE items FIXED
//   - engineerTimeSaved     — estimated minutes (15 min × Phase A items; note: estimate)
//   - cvesAddressed         — total unique CVE IDs across all bundles

const fs   = require('fs');
const path = require('path');

const { OUTCOMES, EXPOSURE } = require('./evidence-model');

// ─── computeKPIs ─────────────────────────────────────────────────────────────

/**
 * Compute KPI metrics from an array of EvidenceBundles.
 * All metrics are derived from the bundles — none are fabricated.
 *
 * @param {object[]} bundles  - EvidenceBundle[]
 * @returns {object} kpis
 */
function computeKPIs(bundles) {
  if (!Array.isArray(bundles) || bundles.length === 0) {
    return _emptyKPIs();
  }

  const totalFindings   = bundles.length;
  const phaseDistribution   = { A: 0, B: 0, C: 0 };
  const outcomeDistribution = {};
  const exposureBreakdown   = {};
  let remediatedCount  = 0;
  let verPassed = 0, verFailed = 0, verRan = 0;
  let rescanResolved = 0, rescanFailed = 0, rescanRan = 0;
  let runtimeReachableFixed = 0;
  const cveIds = new Set();

  for (const b of bundles) {
    // Phase distribution
    if (b.phase) phaseDistribution[b.phase] = (phaseDistribution[b.phase] || 0) + 1;

    // Outcome distribution
    const outcome = b.outcome || 'UNKNOWN';
    outcomeDistribution[outcome] = (outcomeDistribution[outcome] || 0) + 1;

    // Remediated
    if (outcome === OUTCOMES.FIXED) remediatedCount++;

    // Verification
    if (b.verification !== null && b.verification !== undefined) {
      verRan++;
      if (b.verification.passed) verPassed++; else verFailed++;
    }

    // Rescan
    if (b.rescan !== null && b.rescan !== undefined) {
      rescanRan++;
      if (b.rescan.status === 'RESOLVED_AND_RESCANNED') rescanResolved++;
      else if (b.rescan.status === 'VERIFICATION_FAILED') rescanFailed++;
    }

    // Exposure breakdown
    const exp = (b.exposure && b.exposure.classification) || EXPOSURE.UNKNOWN_EXPOSURE;
    exposureBreakdown[exp] = (exposureBreakdown[exp] || 0) + 1;

    // RUNTIME_REACHABLE fixed
    if (exp === EXPOSURE.RUNTIME_REACHABLE && outcome === OUTCOMES.FIXED) {
      runtimeReachableFixed++;
    }

    // CVEs
    for (const c of b.cves || []) {
      if (c.id) cveIds.add(c.id);
    }
  }

  const verificationPassRate = verRan > 0 ? verPassed / verRan : null;
  const rescanClosureRate    = rescanRan > 0 ? rescanResolved / rescanRan : null;

  // Engineer time estimate: 15 min per Phase A item (conservative, labeled as estimate)
  // Phase B/C items are not estimated — they require human review
  const engineerTimeSavedMinutes = phaseDistribution.A * 15;

  return {
    totalFindings,
    phaseDistribution,
    outcomeDistribution,
    remediatedCount,
    verificationPassRate,     // fraction 0–1, or null if no verifications ran
    rescanClosureRate,        // fraction 0–1, or null if no rescans ran
    exposureBreakdown,
    runtimeReachableFixed,    // RUNTIME_REACHABLE items that were FIXED
    cvesAddressed:            cveIds.size,
    // Estimates are clearly labeled as estimates, not measured results
    estimates: {
      engineerTimeSavedMinutes, // 15 min × Phase A count
      basis: 'Phase A items × 15 min per manual triage (industry estimate; not measured)',
    },
  };
}

// ─── generateKPIReport ────────────────────────────────────────────────────────

/**
 * Generate a markdown KPI report from evidence bundles.
 *
 * @param {object[]} bundles
 * @param {object}  [opts]
 * @param {string}  [opts.project]
 * @param {string}  [opts.reportDate]  - ISO date string
 * @param {string}  [opts.runId]
 * @returns {string} markdown
 */
function generateKPIReport(bundles, opts = {}) {
  const kpis   = computeKPIs(bundles);
  const title  = opts.project ? `# Pilot KPI Report — ${opts.project}` : '# Pilot KPI Report';
  const date   = opts.reportDate || new Date().toISOString().slice(0, 10);
  const lines  = [];

  lines.push(title);
  lines.push(`**Generated:** ${date}${opts.runId ? `  |  Run: \`${opts.runId}\`` : ''}`);
  lines.push('');
  lines.push('> All metrics are derived from evidence bundles recorded during this run.');
  lines.push('> No metrics are fabricated or extrapolated from industry averages.');
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Findings analyzed | **${kpis.totalFindings}** |`);
  lines.push(`| Findings remediated (outcome FIXED) | **${kpis.remediatedCount}** |`);
  lines.push(`| CVEs addressed | **${kpis.cvesAddressed}** |`);
  lines.push(`| RUNTIME_REACHABLE items fixed | **${kpis.runtimeReachableFixed}** |`);
  if (kpis.verificationPassRate !== null) {
    lines.push(`| Build/test pass rate | **${_pct(kpis.verificationPassRate)}** (${Math.round(kpis.verificationPassRate * 100)}% of ${_verRan(bundles)} verifications) |`);
  } else {
    lines.push(`| Build/test pass rate | No verifications ran this run |`);
  }
  if (kpis.rescanClosureRate !== null) {
    lines.push(`| Rescan closure rate | **${_pct(kpis.rescanClosureRate)}** (${Math.round(kpis.rescanClosureRate * 100)}% of rescanned items fully resolved) |`);
  } else {
    lines.push(`| Rescan closure rate | No rescans ran this run |`);
  }
  lines.push('');

  // Phase distribution
  lines.push('## Phase Distribution');
  lines.push('');
  lines.push('| Phase | Count | Description |');
  lines.push('|-------|-------|-------------|');
  lines.push(`| ✅ Phase A (Auto-apply) | ${kpis.phaseDistribution.A || 0} | Same-major safe upgrades |`);
  lines.push(`| 🔍 Phase B (Review first) | ${kpis.phaseDistribution.B || 0} | Range violations or multi-version conflicts |`);
  lines.push(`| ⚠️ Phase C (Manual review) | ${kpis.phaseDistribution.C || 0} | Major bumps, no-fix, migration required |`);
  lines.push('');

  // Outcome distribution
  lines.push('## Outcome Distribution');
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('|---------|-------|');
  for (const [outcome, count] of Object.entries(kpis.outcomeDistribution).sort()) {
    lines.push(`| ${outcome} | ${count} |`);
  }
  lines.push('');

  // Exposure breakdown
  lines.push('## Exposure Breakdown');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|----------------|-------|');
  for (const [cls, count] of Object.entries(kpis.exposureBreakdown).sort()) {
    lines.push(`| ${cls} | ${count} |`);
  }
  lines.push('');

  // Engineer time estimate (clearly labeled as estimate)
  lines.push('## Engineer Time Estimate');
  lines.push('');
  lines.push(`> **Note:** This is an estimate, not a measured result.`);
  lines.push(`> Basis: ${kpis.estimates.basis}`);
  lines.push('');
  lines.push(`Estimated time saved: **${kpis.estimates.engineerTimeSavedMinutes} minutes** ` +
    `(${Math.round(kpis.estimates.engineerTimeSavedMinutes / 60 * 10) / 10} hours)`);
  lines.push('');

  return lines.join('\n');
}

// ─── writeKPIReport ───────────────────────────────────────────────────────────

/**
 * Compute and write a KPI report to disk.
 *
 * @param {object[]} bundles
 * @param {string}   outDir
 * @param {object}   [opts]
 * @returns {string} file path written
 */
function writeKPIReport(bundles, outDir, opts = {}) {
  const content  = generateKPIReport(bundles, opts);
  const filename = opts.filename || 'pilot-kpi-report.md';
  const outPath  = path.join(outDir, filename);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _emptyKPIs() {
  return {
    totalFindings: 0,
    phaseDistribution: { A: 0, B: 0, C: 0 },
    outcomeDistribution: {},
    remediatedCount: 0,
    verificationPassRate: null,
    rescanClosureRate: null,
    exposureBreakdown: {},
    runtimeReachableFixed: 0,
    cvesAddressed: 0,
    estimates: { engineerTimeSavedMinutes: 0, basis: 'no findings' },
  };
}

function _pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function _verRan(bundles) {
  return bundles.filter(b => b.verification !== null && b.verification !== undefined).length;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { computeKPIs, generateKPIReport, writeKPIReport };
