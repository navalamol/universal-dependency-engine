'use strict';

/**
 * Comparison report: scanner raw count vs engine outcome.
 * Demonstrates the engine's value over a naive direct-dep-only scanner.
 */

const DEV_CLASSIFICATIONS = new Set([
  'TEST_ONLY', 'LOCAL_TOOLING_ONLY', 'CI_EXECUTED', 'BUILD_TIME_EXECUTED',
]);

/**
 * @param {object[]} scannerEntries   - LibraryEntry[] from provider (raw scanner output)
 * @param {object[]} phasedPlan       - PhasedItem[] from phases.js
 * @param {object[]} exposureResults  - Array<{ item, exposureResult }> from exposure-classifier
 * @param {object}   opts
 * @returns {object} comparison report object
 */
function buildComparisonReport(scannerEntries, phasedPlan, exposureResults, opts = {}) {
  const { project = 'unknown', reportDate = new Date().toISOString().split('T')[0] } = opts;

  // ── Scanner baseline (naive: counts everything as unresolved) ──────────────
  const scannerCveCount = (scannerEntries || []).reduce(
    (n, e) => n + (e.cves || []).length, 0
  );
  const scannerLibCount = (scannerEntries || []).length;

  // ── Engine outcomes ────────────────────────────────────────────────────────
  const phaseA = (phasedPlan || []).filter(r => r.phase === 'A');
  const phaseB = (phasedPlan || []).filter(r => r.phase === 'B');
  const phaseC = (phasedPlan || []).filter(r => r.phase === 'C');

  const phaseACves = phaseA.reduce((n, r) => n + (r.cveCount || 0), 0);
  const phaseBCves = phaseB.reduce((n, r) => n + (r.cveCount || 0), 0);
  const phaseCves  = phaseC.reduce((n, r) => n + (r.cveCount || 0), 0);

  // ── Exposure breakdown ─────────────────────────────────────────────────────
  const exposureMap = new Map();
  for (const { item, exposureResult } of (exposureResults || [])) {
    if (item && item.libraryName) exposureMap.set(item.libraryName, exposureResult);
  }

  const notProductionReachable = (phasedPlan || []).filter(r => {
    const exp = exposureMap.get(r.libraryName);
    return exp && DEV_CLASSIFICATIONS.has(exp.classification);
  }).length;

  // Naive scanner: only direct deps (no transitive awareness)
  // We simulate this by counting libs that appear as root/direct deps.
  // If rootDeps info not available, estimate as libraries with no depChain or depChain length 1.
  const naiveScannerReachable = (scannerEntries || []).filter(e => {
    // If the entry has a depChain, naive scanner only catches direct (chain length ≤ 1)
    return !e.depChain || e.depChain.length <= 1;
  }).length;

  const autoCloseable  = phaseACves + phaseBCves;
  const requiresAction = phaseCves;
  const closedViaParentUpgrade = phaseB.filter(r =>
    r.rootParents && r.rootParents.length > 0
  ).reduce((n, r) => n + (r.cveCount || 0), 0);

  // ── Parent upgrade paths for Phase B ──────────────────────────────────────
  const phaseBParentPaths = phaseB
    .filter(r => r.rootParents && r.rootParents.length > 0)
    .map(r => {
      const parents = r.rootParents.map(p => `\`${p.name}\` ${p.range}`).join(', ');
      const cveList = (r.cves || []).map(c => c.id).slice(0, 4).join(', ');
      const more    = (r.cves || []).length > 4 ? ` +${(r.cves || []).length - 4} more` : '';
      return `upgrading ${parents} closes \`${r.libraryName}\` ${cveList}${more}`;
    });

  // ── Phase C top migration alternative ─────────────────────────────────────
  const phaseCMigrations = phaseC.map(r => {
    const alt = r.alternatives && r.alternatives[0];
    const effort = alt ? (alt.effort || 'unknown') : 'unknown';
    const altName = alt ? alt.name : '(no alternative identified)';
    return { lib: r.libraryName, alternative: altName, effort };
  });

  // ── Narrative ─────────────────────────────────────────────────────────────
  const reductionPct = scannerCveCount > 0
    ? Math.round((autoCloseable / scannerCveCount) * 100) : 0;
  const fpPct = scannerCveCount > 0
    ? Math.round((notProductionReachable / scannerLibCount) * 100) : 0;

  const narrative =
    `Out of ${scannerCveCount} CVEs across ${scannerLibCount} libraries flagged by the scanner, ` +
    `the engine automatically closes ${autoCloseable} (${reductionPct}%) via Phase A/B overrides, ` +
    `leaving ${requiresAction} CVEs requiring manual action. ` +
    (notProductionReachable > 0
      ? `${notProductionReachable} libraries (${fpPct}% of affected) are classified as dev/test-only, ` +
        `meaning they are not reachable in production. `
      : '') +
    `A naive scanner surfacing only direct dependencies would miss the transitive resolution strategy ` +
    `that makes ${autoCloseable} CVEs auto-closeable without code changes.`;

  return {
    project,
    reportDate,
    scanner: {
      totalLibraries: scannerLibCount,
      totalCves: scannerCveCount,
      naiveDirectDepCount: naiveScannerReachable,
    },
    engine: {
      autoCloseable,
      closedViaParentUpgrade,
      requiresAction,
      notProductionReachable,
    },
    phaseBreakdown: {
      A: { libraries: phaseA.length, cves: phaseACves },
      B: { libraries: phaseB.length, cves: phaseBCves },
      C: { libraries: phaseC.length, cves: phaseCves  },
    },
    phaseBParentPaths,
    phaseCMigrations,
    narrative,
  };
}

/**
 * Render comparison report as a markdown table.
 */
function renderComparisonReport(report) {
  const { scanner, engine, phaseBreakdown, phaseBParentPaths, phaseCMigrations, narrative } = report;

  const lines = [
    `# Dependency Intelligence Engine — Before / After Comparison`,
    ``,
    `**Project:** ${report.project}  `,
    `**Generated:** ${report.reportDate}`,
    ``,
    `## Scanner Baseline vs Engine Output`,
    ``,
    `| Metric | Naive Scanner | Engine |`,
    `|--------|--------------|--------|`,
    `| Total libraries flagged | ${scanner.totalLibraries} | ${scanner.totalLibraries} |`,
    `| Total CVEs surfaced | ${scanner.totalCves} | ${scanner.totalCves} |`,
    `| Auto-closeable (Phase A + B) | — | **${engine.autoCloseable}** |`,
    `| Requires manual action (Phase C) | ${scanner.totalCves} | **${engine.requiresAction}** |`,
    `| Not production-reachable (dev/test only) | — | **${engine.notProductionReachable}** |`,
    ``,
    `## Phase Distribution`,
    ``,
    `| Phase | Action | Libraries | CVEs |`,
    `|-------|--------|-----------|------|`,
    `| ✅ A — Auto-apply | Override/pin, no code change | ${phaseBreakdown.A.libraries} | ${phaseBreakdown.A.cves} |`,
    `| ⚠️ B — Review first | Forced override, verify deps | ${phaseBreakdown.B.libraries} | ${phaseBreakdown.B.cves} |`,
    `| ❌ C — Manual review | Major bump or no fix | ${phaseBreakdown.C.libraries} | ${phaseBreakdown.C.cves} |`,
    ``,
  ];

  if (phaseBParentPaths && phaseBParentPaths.length > 0) {
    lines.push(`## Phase B — Parent Upgrade Paths`);
    lines.push(``);
    lines.push(`These CVEs can be closed by upgrading a parent dependency:`);
    lines.push(``);
    for (const p of phaseBParentPaths) {
      lines.push(`- ${p}`);
    }
    lines.push(``);
  }

  if (phaseCMigrations && phaseCMigrations.length > 0) {
    lines.push(`## Phase C — Migration Alternatives`);
    lines.push(``);
    lines.push(`| Library | Top Alternative | Effort |`);
    lines.push(`|---------|----------------|--------|`);
    for (const m of phaseCMigrations) {
      lines.push(`| \`${m.lib}\` | ${m.alternative} | ${m.effort} |`);
    }
    lines.push(``);
  }

  lines.push(`## Value Proposition`);
  lines.push(``);
  lines.push(narrative);
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Full SARIF at \`remediation-evidence.sarif\`, VEX at \`remediation.vex.json\`*`);

  return lines.join('\n');
}

module.exports = { buildComparisonReport, renderComparisonReport };
