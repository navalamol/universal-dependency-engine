'use strict';

const fs   = require('fs');
const path = require('path');

const SEVERITY_BADGE = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢', NONE: '⚪' };

function badge(severity) {
  return SEVERITY_BADGE[severity] || '⚪';
}

// ---------------------------------------------------------------------------
// Report generator
// ---------------------------------------------------------------------------

function generatePortfolioReport(portfolio, opts = {}) {
  const {
    repos, totalRepos, totalCves, totalLibraries,
    totalPhaseA, totalPhaseB, totalPhaseC,
    criticalCount, highCount, mediumCount, lowCount,
    runDate,
  } = portfolio;

  const date = runDate || opts.date || new Date().toISOString().split('T')[0];

  const lines = [
    `# Portfolio Vulnerability Report`,
    ``,
    `**Date:** ${date}  `,
    `**Repos scanned:** ${totalRepos}  `,
    `**Total CVEs:** ${totalCves}  `,
    `**Total affected libraries:** ${totalLibraries}  `,
    ``,
  ];

  // Severity summary
  lines.push(`## Severity Summary`);
  lines.push(``);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  if (criticalCount > 0) lines.push(`| 🔴 CRITICAL | ${criticalCount} |`);
  if (highCount     > 0) lines.push(`| 🟠 HIGH | ${highCount} |`);
  if (mediumCount   > 0) lines.push(`| 🟡 MEDIUM | ${mediumCount} |`);
  if (lowCount      > 0) lines.push(`| 🟢 LOW | ${lowCount} |`);
  if (criticalCount + highCount + mediumCount + lowCount === 0) {
    lines.push(`| ⚪ NONE | 0 |`);
  }
  lines.push(``);

  // Phase distribution
  lines.push(`## Remediation Phase Distribution`);
  lines.push(``);
  lines.push(`| Phase | Libraries | Description |`);
  lines.push(`|-------|-----------|-------------|`);
  lines.push(`| ✅ Phase A (Auto-apply)     | ${totalPhaseA} | 95–100% confidence — safe to auto-apply |`);
  lines.push(`| ⚠️  Phase B (Review first)  | ${totalPhaseB} | 60–95% confidence — review before applying |`);
  lines.push(`| ❌ Phase C (Manual review) | ${totalPhaseC} | <60% confidence — justification required |`);
  lines.push(``);

  // Per-repo summary table
  lines.push(`## Repository Summary`);
  lines.push(``);
  lines.push(`| Repository | Ecosystem | CVEs | Critical | High | Phase A | Phase B | Phase C | Status |`);
  lines.push(`|------------|-----------|------|----------|------|---------|---------|---------|--------|`);
  for (const repo of repos) {
    if (repo.status === 'error') {
      lines.push(`| ${repo.name} | — | — | — | — | — | — | — | ❌ ERROR |`);
    } else {
      const b = badge(repo.highestSeverity);
      lines.push(`| ${repo.name} | ${repo.ecosystem || '?'} | ${repo.totalCves} | ${repo.criticalCount} | ${repo.highCount} | ${repo.phaseA.length} | ${repo.phaseB.length} | ${repo.phaseC.length} | ${b} OK |`);
    }
  }
  lines.push(``);

  // Error details
  const errors = repos.filter(r => r.status === 'error');
  if (errors.length > 0) {
    lines.push(`## Errors`);
    lines.push(``);
    for (const repo of errors) {
      lines.push(`### ${repo.name}`);
      lines.push(``);
      lines.push(`\`\`\``);
      lines.push(repo.error || '(unknown error)');
      lines.push(`\`\`\``);
      lines.push(``);
    }
  }

  // Per-repo detail
  lines.push(`## Repository Details`);
  lines.push(``);
  for (const repo of repos) {
    if (repo.status === 'error') continue;

    lines.push(`### ${repo.name}`);
    lines.push(``);
    lines.push(`**Ecosystem:** ${repo.ecosystem || 'unknown'}  `);
    lines.push(`**Provider:** ${repo.provider || 'unknown'}  `);
    lines.push(`**Libraries:** ${repo.totalLibraries} | **CVEs:** ${repo.totalCves}  `);
    lines.push(`**Severity:** ${badge(repo.highestSeverity)} ${repo.highestSeverity}  `);
    lines.push(``);

    if (repo.phaseA.length > 0) {
      lines.push(`**Phase A (auto-apply):**`);
      for (const item of repo.phaseA) {
        lines.push(`- \`${item.libraryName}\`: ${item.currentVersion} → ${item.recommendedVersion}`);
      }
      lines.push(``);
    }

    if (repo.phaseB.length > 0) {
      lines.push(`**Phase B (review first):**`);
      for (const item of repo.phaseB) {
        const fix = item.parentUpgradePaths && item.parentUpgradePaths.length
          ? item.parentUpgradePaths.map(p => `${p.parent}@${p.parentUpgradeVersion}`).join(', ')
          : (item.recommendedVersion || 'see report');
        lines.push(`- \`${item.libraryName}\`: ${item.currentVersion} → ${fix}`);
      }
      lines.push(``);
    }

    if (repo.phaseC.length > 0) {
      lines.push(`**Phase C (manual review):**`);
      for (const item of repo.phaseC) {
        const fix = item.recommendedVersion || 'NO FIX';
        const fp  = item.probableFalsePositive ? ' _(probable false positive)_' : '';
        lines.push(`- \`${item.libraryName}\`: ${item.currentVersion} → ${fix} [${item.upgradeType}]${fp}`);
      }
      lines.push(``);
    }

    if (repo.phaseA.length === 0 && repo.phaseB.length === 0 && repo.phaseC.length === 0) {
      lines.push(`_No vulnerabilities found._`);
      lines.push(``);
    }
  }

  // Recommended action order — CRITICAL first, then total CVEs
  const actionable = repos
    .filter(r => r.status === 'ok' && (r.phaseA.length + r.phaseB.length + r.phaseC.length > 0))
    .sort((a, b) =>
      b.criticalCount - a.criticalCount ||
      b.highCount     - a.highCount     ||
      b.totalCves     - a.totalCves
    );

  if (actionable.length > 0) {
    lines.push(`## Recommended Action Order`);
    lines.push(``);
    lines.push(`Repos ordered by severity (CRITICAL first), then total CVE count.`);
    lines.push(``);
    let rank = 1;
    for (const repo of actionable) {
      const autoNote = repo.phaseA.length > 0
        ? ` — ${repo.phaseA.length} Phase A (auto-apply)`
        : '';
      lines.push(`${rank++}. **${repo.name}** — ${repo.totalCves} CVEs${autoNote}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

function writePortfolioReport(portfolio, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'portfolio-report.md');
  fs.writeFileSync(reportPath, generatePortfolioReport(portfolio, opts));
  return reportPath;
}

module.exports = { generatePortfolioReport, writePortfolioReport };
