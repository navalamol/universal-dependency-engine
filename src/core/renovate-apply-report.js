'use strict';

const fs   = require('fs');
const path = require('path');

function prRef(prNumber, prTitle) {
  return prTitle ? `PR #${prNumber}: ${prTitle}` : `PR #${prNumber}`;
}

function prNumbers(items) {
  return items.map(i => `#${i.prNumber}`).join(', ') || '-';
}

function renderPhaseASection(phaseAItems) {
  if (phaseAItems.length === 0) return '';
  const rows = phaseAItems.map(item => {
    const type = item._directUpgrade ? 'direct dep bump' : 'override';
    const status = item._applied ? 'applied' : 'ready';
    return `| #${item.prNumber} | ${item.libraryName} | ${item.currentVersion} | ${item.recommendedVersion} | ${type} | ${status} |`;
  });
  return [
    '## Phase A — Safe Upgrades (applied)',
    '',
    '| PR | Package | Current | Proposed | Type | Status |',
    '|----|---------|---------|---------|------|--------|',
    ...rows,
    '',
  ].join('\n');
}

function renderPhaseBSection(phaseBItems) {
  if (phaseBItems.length === 0) return '';
  const rows = phaseBItems.map(item =>
    `| #${item.prNumber} | ${item.libraryName} | ${item.currentVersion} | ${item.recommendedVersion} | ${item.justification} |`
  );
  return [
    '## Phase B — Review Before Applying',
    '',
    '| PR | Package | Current | Proposed | Reason |',
    '|----|---------|---------|---------|--------|',
    ...rows,
    '',
  ].join('\n');
}

function renderPhaseCSection(phaseCItems) {
  if (phaseCItems.length === 0) return '';

  const blocks = phaseCItems.map(item => {
    const fix = item.recommendedVersion || 'N/A';
    const lines = [
      `### PR #${item.prNumber}: \`${item.libraryName}\` ${item.currentVersion} → ${fix}`,
      ``,
      `- **Type:** ${item.upgradeType}`,
      `- **Justification:** ${item.justification}`,
    ];
    if (item.evidence)    lines.push(`- **Evidence:** ${item.evidence}`);
    if (item.alternative) lines.push(`- **Alternative:** ${item.alternative}`);
    lines.push(`- **Manual review file:** manual-review.md`);
    lines.push(``);
    return lines.join('\n');
  });

  return [
    '## Phase C — Risky / Not Applied',
    '',
    '_These upgrades require manual review. See `manual-review.md` for action checklists._',
    '',
    ...blocks,
  ].join('\n');
}

function renderNotFoundSection(notFound) {
  const groups   = notFound.filter(i => i.isMonorepoGroup || i.isPackageGroup);
  const regular  = notFound.filter(i => !i.isMonorepoGroup && !i.isPackageGroup);

  const sections = [];

  if (groups.length > 0) {
    const rows = groups.map(item => {
      const kind    = item.isMonorepoGroup ? 'monorepo group' : 'packages group';
      const version = item.proposedVersion || '—';
      return `| #${item.prNumber} | ${item.packageName} (${kind}) | ${version} |`;
    });
    sections.push(
      '## Group PRs — No Direct Package Match',
      '',
      '_Renovate bundled these as a monorepo or package-group update. No single package with this name exists in package.json / package-lock.json. Review each package in the group individually._',
      '',
      '| PR | Group | Renovate Proposes |',
      '|----|-------|------------------|',
      ...rows,
      '',
    );
  }

  if (regular.length > 0) {
    const rows = regular.map(item =>
      `| #${item.prNumber} | ${item.packageName} | ${item.proposedVersion} |`
    );
    sections.push(
      '## Not Found in This Repo',
      '',
      '_These packages from Renovate PRs were not found in package.json or package-lock.json._',
      '',
      '| PR | Package | Renovate Proposes |',
      '|----|---------|------------------|',
      ...rows,
      '',
    );
  }

  return sections.join('\n');
}

/**
 * Generate a renovate-report.md string for one repo.
 *
 * @param {object} params
 * @param {string} params.repoName
 * @param {string} params.org
 * @param {string} params.runDate
 * @param {object[]} params.phasedItems   PhasedItem[] with prNumber/prTitle extras
 * @param {object[]} params.notFound      [{prNumber, prTitle, packageName, proposedVersion}]
 * @param {boolean}  params.applied       true if --apply was used
 * @param {object[]} params.verifyFailures from verifyFixVersions()
 * @param {string[]} params.errors
 */
function generateApplyReport({ repoName, org, runDate, phasedItems, notFound, applied, verifyFailures, errors }) {
  const phaseA = phasedItems.filter(i => i.phase === 'A');
  const phaseB = phasedItems.filter(i => i.phase === 'B');
  const phaseC = phasedItems.filter(i => i.phase === 'C');

  const groupPRs   = notFound.filter(n => n.isMonorepoGroup || n.isPackageGroup);
  const regularNF  = notFound.filter(n => !n.isMonorepoGroup && !n.isPackageGroup);

  const summaryRows = [
    `| Phase A — safe upgrade    | ${phaseA.length} | ${prNumbers(phaseA)} |`,
    `| Phase B — review first    | ${phaseB.length} | ${prNumbers(phaseB)} |`,
    `| Phase C — risky / manual  | ${phaseC.length} | ${prNumbers(phaseC)} |`,
    `| Group PRs (no pkg match)  | ${groupPRs.length} | ${groupPRs.map(n => `#${n.prNumber}`).join(', ') || '-'} |`,
    `| Not found in repo         | ${regularNF.length} | ${regularNF.map(n => `#${n.prNumber}`).join(', ') || '-'} |`,
  ];

  const sections = [
    `# Renovate Upgrade Analysis — ${org}/${repoName}`,
    ``,
    `Run date: ${runDate}  |  Applied: ${applied ? 'yes (--apply)' : 'no (report only)'}`,
    ``,
    `## Summary`,
    ``,
    `| Category | Count | PR Numbers |`,
    `|----------|-------|-----------|`,
    ...summaryRows,
    ``,
    renderPhaseASection(phaseA),
    renderPhaseBSection(phaseB),
    renderPhaseCSection(phaseC),
    renderNotFoundSection(notFound),
  ];

  if (verifyFailures && verifyFailures.length > 0) {
    sections.push(
      '## Post-Install Verification Failures',
      '',
      '| Package | Expected >= | Resolved Versions |',
      '|---------|------------|------------------|',
      ...verifyFailures.map(f =>
        `| ${f.libraryName} | ${f.expected} | ${f.resolved.join(', ')} |`
      ),
      ''
    );
  }

  if (errors && errors.length > 0) {
    sections.push('## Errors', '', ...errors.map(e => `- ${e}`), '');
  }

  return sections.join('\n');
}

/**
 * Write renovate-report.md to outDir.
 */
function writeApplyReport(params, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const content = generateApplyReport(params);
  fs.writeFileSync(path.join(outDir, 'renovate-report.md'), content, 'utf8');
}

module.exports = { generateApplyReport, writeApplyReport };
