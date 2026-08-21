'use strict';

const { PHASE_META } = require('./phases');

const ICON = {
  CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', UNKNOWN: '⚪',
  A: '✅', B: '⚠️', C: '❌',
};

const DEV_EXPOSURE_CLASSES = new Set([
  'TEST_ONLY', 'LOCAL_TOOLING_ONLY', 'CI_EXECUTED', 'BUILD_TIME_EXECUTED',
]);

function sevIcon(s) { return ICON[(s || '').toUpperCase()] || '⚪'; }

/**
 * Generate the full markdown remediation report (all 3 phases).
 */
function generateReport(phasedPlan, options = {}) {
  const {
    project    = 'unknown',
    reportDate = new Date().toISOString().split('T')[0],
    verifyVersions = false,
    ecosystem  = 'npm',
    exposureResults = [],
  } = options;

  const phaseA = phasedPlan.filter(r => r.phase === 'A');
  const phaseB = phasedPlan.filter(r => r.phase === 'B');
  const phaseC = phasedPlan.filter(r => r.phase === 'C');

  const totalCves = phasedPlan.reduce((n, r) => n + r.cveCount, 0);
  const phaseACves = phaseA.reduce((n, r) => n + r.cveCount, 0);
  const phaseBCves = phaseB.reduce((n, r) => n + r.cveCount, 0);
  const phaseCCves = phaseC.reduce((n, r) => n + r.cveCount, 0);

  // directDeps: optional Set<string> of package names that are root direct deps —
  // they should be bumped in package.json directly, not via npm overrides.
  const directDepNames = options.directDeps || new Set();
  const overrides      = {};
  const directBumps    = {};
  for (const r of phaseA) {
    if (!r.recommendedVersion) continue;
    if (directDepNames.has(r.libraryName)) {
      directBumps[r.libraryName] = r.recommendedVersion;
    } else {
      overrides[r.libraryName] = r.recommendedVersion;
    }
  }

  // ── Exposure summary ───────────────────────────────────────────────────────
  const exposureMap = new Map();
  for (const { item, exposureResult } of (exposureResults || [])) {
    if (item && item.libraryName) exposureMap.set(item.libraryName, exposureResult);
  }

  const expTiers = {};
  for (const [, exp] of exposureMap) {
    const cls = (exp && exp.classification) || 'UNKNOWN_EXPOSURE';
    expTiers[cls] = (expTiers[cls] || 0) + 1;
  }

  const fpCount = phasedPlan.filter(r => {
    const exp = exposureMap.get(r.libraryName);
    return exp && DEV_EXPOSURE_CLASSES.has(exp.classification);
  }).length;

  const lines = [
    `# Mend Vulnerability Remediation Report`,
    ``,
    `**Project:** ${project}  `,
    `**Generated:** ${reportDate}  `,
    `**Ecosystem:** ${ecosystem}  `,
    `**Version verification:** ${verifyVersions ? `Yes (${ecosystem === 'maven' ? 'Maven Central' : 'npm registry'})` : 'No (use --verify-versions to enable)'}`,
    ``,
    `## Summary`,
    ``,
    `| Phase | Confidence | Libraries | CVEs | Action |`,
    `|-------|-----------|-----------|------|--------|`,
    `| ✅ Phase A | ${PHASE_META.A.confidence} | ${phaseA.length} | ${phaseACves} | Auto-apply |`,
    `| ⚠️ Phase B | ${PHASE_META.B.confidence} | ${phaseB.length} | ${phaseBCves} | Review first |`,
    `| ❌ Phase C | ${PHASE_META.C.confidence} | ${phaseC.length} | ${phaseCCves} | Justification needed |`,
    `| **Total** | | **${phasedPlan.length}** | **${totalCves}** | |`,
    ``,
  ];

  // ── Exposure summary table (when D1A data present) ─────────────────────────
  if (exposureMap.size > 0) {
    lines.push(`## Exposure Classification`);
    lines.push(``);
    lines.push(`| Tier | Libraries | Notes |`);
    lines.push(`|------|-----------|-------|`);
    const tierOrder = [
      ['RUNTIME_REACHABLE',    'Production-reachable; highest priority'],
      ['PRODUCTION_BUNDLED',   'Bundled into production artifact'],
      ['TEST_ONLY',            'Dev/test only; not deployed to production'],
      ['BUILD_TIME_EXECUTED',  'Executes at build time only'],
      ['CI_EXECUTED',          'Executes in CI only'],
      ['LOCAL_TOOLING_ONLY',   'Developer tooling; not deployed'],
      ['UNKNOWN_EXPOSURE',     'Insufficient data to classify'],
    ];
    for (const [cls, note] of tierOrder) {
      const count = expTiers[cls] || 0;
      if (count > 0) lines.push(`| ${cls} | ${count} | ${note} |`);
    }
    if (fpCount > 0) {
      lines.push(``);
      lines.push(`> **${fpCount} librar${fpCount === 1 ? 'y is' : 'ies are'} classified as dev/test-only** — these findings may be deprioritised as they are not production-reachable.`);
    }
    lines.push(``);
  }

  // ── Phase A ────────────────────────────────────────────────────────────────
  if (phaseA.length > 0) {
    lines.push(`## ✅ Phase A — High Confidence (${PHASE_META.A.confidence})`);
    lines.push(``);
    lines.push(PHASE_META.A.description);
    lines.push(``);

    if (verifyVersions) {
      lines.push(`| Package | Current → Fix | Decision | Verified | CVEs | Severity |`);
      lines.push(`|---------|---------------|----------|----------|------|----------|`);
      for (const r of phaseA) {
        const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
        const verifiedTag = r.registryExists === true
          ? (r.registryAdjusted ? `✓ adjusted from ${r.registryRequested}` : '✓')
          : (r.registryExists === null ? '? (registry unreachable)' : '✗ not found');
        const dlabel = r.decisionLabel || 'SAFE_ALIGNED';
        lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${dlabel} | ${verifiedTag} | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} |`);
      }
    } else {
      lines.push(`| Package | Current → Fix | Decision | CVEs | Severity |`);
      lines.push(`|---------|---------------|----------|------|----------|`);
      for (const r of phaseA) {
        const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
        const dlabel = r.decisionLabel || 'SAFE_ALIGNED';
        lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${dlabel} | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} |`);
      }
    }

    lines.push(``);
    if (ecosystem === 'maven') {
      lines.push(`**\`<dependencyManagement>\` entries to add:**`);
      lines.push(``);
      lines.push('```xml');
      lines.push('<dependencyManagement>');
      lines.push('  <dependencies>');
      for (const r of phaseA) {
        if (!r.recommendedVersion) continue;
        lines.push(`    <dependency>`);
        lines.push(`      <groupId>${r.groupId || 'UNKNOWN_GROUP'}</groupId>`);
        lines.push(`      <artifactId>${r.libraryName}</artifactId>`);
        lines.push(`      <version>${r.recommendedVersion}</version>`);
        lines.push(`    </dependency>`);
      }
      lines.push('  </dependencies>');
      lines.push('</dependencyManagement>');
      lines.push('```');
      lines.push(``);
      lines.push(`After applying: run \`mvn dependency:resolve\` to confirm resolution.`);
    } else {
      if (Object.keys(directBumps).length > 0) {
        lines.push(`**Direct dependency bumps** (packages you own directly — bump the version in \`package.json\`'s \`dependencies\` / \`devDependencies\`):`);
        lines.push(``);
        lines.push('```json');
        lines.push(JSON.stringify({ dependencies: directBumps }, null, 2));
        lines.push('```');
        lines.push(``);
      }
      if (Object.keys(overrides).length > 0) {
        lines.push(`**Overrides to apply** (transitive dependencies — add to \`package.json\`'s \`overrides\` section):`);
        lines.push(``);
        lines.push('```json');
        lines.push(JSON.stringify({ overrides }, null, 2));
        lines.push('```');
        lines.push(``);
      }
      lines.push(`After applying: \`npm install --package-lock-only --legacy-peer-deps\``);
    }
    lines.push(``);
  }

  // ── Phase B ────────────────────────────────────────────────────────────────
  if (phaseB.length > 0) {
    lines.push(`## ⚠️ Phase B — Low Confidence (${PHASE_META.B.confidence})`);
    lines.push(``);
    lines.push(PHASE_META.B.description);
    lines.push(``);
    lines.push(`| Package | Current → Fix | Decision | CVEs | Severity | Notes |`);
    lines.push(`|---------|---------------|----------|------|----------|-------|`);
    for (const r of phaseB) {
      const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
      const dlabel = r.decisionLabel || 'CONTROLLED_OVERRIDE';
      lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${dlabel} | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} | ${r.justification} |`);
    }
    lines.push(``);

    // Parent upgrade paths for Phase B items
    const bWithParents = phaseB.filter(r => r.rootParents && r.rootParents.length > 0);
    if (bWithParents.length > 0) {
      lines.push(`**Parent upgrade paths** (upgrading these closes the Phase B CVEs without overrides):`);
      lines.push(``);
      for (const r of bWithParents) {
        const parents = r.rootParents.map(p => `\`${p.name}\` (${p.range})`).join(', ');
        const cveIds  = (r.cves || []).map(c => c.id).slice(0, 4).join(', ');
        const more    = (r.cves || []).length > 4 ? ` +${(r.cves || []).length - 4} more` : '';
        lines.push(`- Upgrading ${parents} closes \`${r.libraryName}\` — ${cveIds}${more}`);
      }
      lines.push(``);
    }
  }

  // ── Phase C ────────────────────────────────────────────────────────────────
  if (phaseC.length > 0) {
    lines.push(`## ❌ Phase C — Requires Review & Justification (${PHASE_META.C.confidence})`);
    lines.push(``);
    lines.push(PHASE_META.C.description);
    lines.push(``);

    for (const r of phaseC) {
      const fixDisplay = r.recommendedVersion || '—';
      const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
      const fpTag = r.probableFalsePositive ? ' ⚠️ Probable False Positive' : '';
      lines.push(`### \`${r.libraryName}\` — ${r.currentVersion} → ${fixDisplay}${fpTag}`);
      lines.push(``);
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| Decision | ${r.decisionLabel || 'MANUAL_SECURITY_REVIEW'} |`);
      lines.push(`| Upgrade type | ${r.upgradeType} |`);
      lines.push(`| Severity | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} (CVSS ${r.highestCvssScore}) |`);
      lines.push(`| CVEs | ${cves} |`);
      lines.push(`| Justification | ${r.justification} |`);
      if (r.depChain && r.depChain.length > 1) {
        lines.push(`| Dependency chain | ${r.depChain.join(' → ')} |`);
      }
      if (r.rootParents && r.rootParents.length > 0) {
        const parentList = r.rootParents.map(p => `\`${p.name}\` (${p.range}${p.isDev ? ', dev' : ''})`).join(', ');
        lines.push(`| Parent upgrade path | Consider upgrading ${parentList} to a version that ships a patched \`${r.libraryName}\` |`);
      }
      if (r.alternatives && r.alternatives.length > 0) {
        const top = r.alternatives[0];
        const effort = top.effort || 'unknown';
        lines.push(`| Top migration alternative | \`${top.name || top}\` — effort: ${effort} |`);
      }
      lines.push(``);
    }
  }

  // ── CVE Detail table ───────────────────────────────────────────────────────
  lines.push(`## CVE Detail`);
  lines.push(``);
  lines.push(`| CVE | Library | Current | Fix | Phase | Severity | Score |`);
  lines.push(`|-----|---------|---------|-----|-------|----------|-------|`);

  for (const r of phasedPlan) {
    for (const cve of r.cves) {
      const fix = r.recommendedVersion || '—';
      const cveLink = `[\`${cve.id}\`](https://www.mend.io/vulnerability-database/${cve.id})`;
      lines.push(`| ${cveLink} | \`${r.libraryName}\` | ${r.currentVersion} | ${fix} | ${ICON[r.phase] || r.phase} ${r.phase} | ${sevIcon(cve.severity)} ${cve.severity} | ${cve.score} |`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`*Evidence trail: Full SARIF at \`remediation-evidence.sarif\`, VEX at \`remediation.vex.json\`*`);

  return lines.join('\n');
}

module.exports = { generateReport };
