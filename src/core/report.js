'use strict';

const { PHASE_META } = require('./phases');

const ICON = {
  CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', UNKNOWN: '⚪',
  A: '✅', B: '⚠️', C: '❌',
};

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
  } = options;

  const phaseA = phasedPlan.filter(r => r.phase === 'A');
  const phaseB = phasedPlan.filter(r => r.phase === 'B');
  const phaseC = phasedPlan.filter(r => r.phase === 'C');

  const totalCves = phasedPlan.reduce((n, r) => n + r.cveCount, 0);
  const phaseACves = phaseA.reduce((n, r) => n + r.cveCount, 0);
  const phaseBCves = phaseB.reduce((n, r) => n + r.cveCount, 0);
  const phaseCCves = phaseC.reduce((n, r) => n + r.cveCount, 0);

  const overrides = {};
  for (const r of phaseA) {
    if (r.recommendedVersion) overrides[r.libraryName] = r.recommendedVersion;
  }

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

  // ── Phase A ────────────────────────────────────────────────────────────────
  if (phaseA.length > 0) {
    lines.push(`## ✅ Phase A — High Confidence (${PHASE_META.A.confidence})`);
    lines.push(``);
    lines.push(PHASE_META.A.description);
    lines.push(``);

    if (verifyVersions) {
      lines.push(`| Package | Current → Fix | Verified | CVEs | Severity |`);
      lines.push(`|---------|---------------|----------|------|----------|`);
      for (const r of phaseA) {
        const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
        const verifiedTag = r.registryExists === true
          ? (r.registryAdjusted ? `✓ adjusted from ${r.registryRequested}` : '✓')
          : (r.registryExists === null ? '? (registry unreachable)' : '✗ not found');
        lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${verifiedTag} | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} |`);
      }
    } else {
      lines.push(`| Package | Current → Fix | CVEs | Severity |`);
      lines.push(`|---------|---------------|------|----------|`);
      for (const r of phaseA) {
        const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
        lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} |`);
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
      lines.push(`**Overrides to apply:**`);
      lines.push(``);
      lines.push('```json');
      lines.push(JSON.stringify({ overrides }, null, 2));
      lines.push('```');
      lines.push(``);
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
    lines.push(`| Package | Current → Fix | CVEs | Severity | Notes |`);
    lines.push(`|---------|---------------|------|----------|-------|`);
    for (const r of phaseB) {
      const cves = r.cves.map(c => `\`${c.id}\``).join(', ');
      lines.push(`| \`${r.libraryName}\` | ${r.currentVersion} → **${r.recommendedVersion}** | ${cves} | ${sevIcon(r.highestSeverity)} ${r.highestSeverity} | ${r.justification} |`);
    }
    lines.push(``);
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

  return lines.join('\n');
}

module.exports = { generateReport };
