'use strict';

// D3.6 — Upstream disclosure preparation.
// Builds a structured responsible-disclosure draft.
// NEVER sends externally — explicit human security-team approval always required.
// Output is files on disk; no HTTP calls are made here.

const fs   = require('fs');
const path = require('path');

const DISCLOSURE_STATUS = Object.freeze({
  DRAFT:    'DRAFT',    // not yet reviewed
  REVIEWED: 'REVIEWED', // internally reviewed by security team
  APPROVED: 'APPROVED', // approved for sending
  SENT:     'SENT',     // sent to upstream (recorded externally)
});

/**
 * Build a disclosure draft from a PhasedItem.
 *
 * @param {object} item           PhasedItem
 * @param {object} [opts]
 * @param {string} [opts.reporterName]    reporter name / organisation
 * @param {string} [opts.reporterEmail]   contact email for upstream maintainer reply
 * @param {string} [opts.repositoryUrl]   upstream repository URL
 * @param {string} [opts.discoveredAt]    ISO timestamp override
 * @returns {DisclosureDraft}
 */
function buildDisclosureDraft(item, opts = {}) {
  if (!item || !item.libraryName) throw new Error('item.libraryName required');

  const {
    reporterName   = null,
    reporterEmail  = null,
    repositoryUrl  = null,
    discoveredAt   = new Date().toISOString(),
  } = opts;

  const cves = (item.cves || []).map(c => ({
    id:       c.id,
    severity: c.severity || null,
    score:    c.score    || null,
  }));

  return {
    status:            DISCLOSURE_STATUS.DRAFT,
    requiresApproval:  true,
    autoSend:          false,

    pkgName:           item.libraryName,
    installedVersion:  item.currentVersion,
    fixVersion:        item.recommendedVersion || null,
    repositoryUrl,
    ecosystem:         item.libraryType || null,
    phase:             item.phase        || null,

    cves,
    severity:          item.highestSeverity || null,

    reporterName,
    reporterEmail,

    timeline: {
      discoveredAt,
      reportedAt:  null,
      resolvedAt:  null,
    },

    impactStatement: [
      `Package: ${item.libraryName}`,
      `Installed version: ${item.currentVersion}`,
      `Recommended fix: ${item.recommendedVersion || 'none available'}`,
      `CVEs: ${cves.map(c => c.id).join(', ') || 'none listed'}`,
      '',
      'Impact assessment: [TO BE COMPLETED BY SECURITY TEAM]',
      'Reproduction steps: [TO BE COMPLETED BY SECURITY TEAM]',
    ].join('\n'),

    warnings: [
      'This disclosure draft must be reviewed and approved before sending.',
      'Do not send directly — route through your security team.',
    ],
  };
}

/**
 * Render a disclosure draft to markdown.
 *
 * @param {DisclosureDraft} draft
 * @returns {string}
 */
function renderDisclosureDraft(draft) {
  const cveList = draft.cves.length
    ? draft.cves.map(c => `- ${c.id} (${c.severity || 'unknown'}, CVSS ${c.score || '?'})`).join('\n')
    : '- None listed';

  const lines = [
    `# Vulnerability Disclosure Draft — ${draft.pkgName}`,
    '',
    `> **Status: ${draft.status}** — ${draft.warnings.join(' ')}`,
    '',
    '## Package',
    `- Name: \`${draft.pkgName}\``,
    `- Installed version: \`${draft.installedVersion}\``,
    `- Fix version: \`${draft.fixVersion || 'none available'}\``,
    `- Ecosystem: ${draft.ecosystem || 'unknown'}`,
  ];

  if (draft.repositoryUrl) lines.push(`- Repository: ${draft.repositoryUrl}`);

  lines.push(
    '',
    '## Vulnerabilities',
    cveList,
    '',
    '## Impact Assessment',
    '```',
    draft.impactStatement,
    '```',
    '',
    '## Reporter',
    `- Name: ${draft.reporterName || '[not provided]'}`,
    `- Contact: ${draft.reporterEmail || '[not provided]'}`,
    '',
    '## Timeline',
    `- Discovered: ${draft.timeline.discoveredAt}`,
    `- Reported: ${draft.timeline.reportedAt || '[pending]'}`,
    `- Resolved: ${draft.timeline.resolvedAt || '[pending]'}`,
    '',
    '---',
    '**DO NOT SEND WITHOUT EXPLICIT SECURITY TEAM APPROVAL**',
  );

  return lines.join('\n');
}

/**
 * Write a disclosure draft to disk (markdown + JSON).
 *
 * @param {object} item    PhasedItem
 * @param {string} outDir
 * @param {object} [opts]
 * @returns {string} path to written markdown file
 */
function writeDisclosureDraft(item, outDir, opts = {}) {
  const draft = buildDisclosureDraft(item, opts);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const safeName = item.libraryName
    .replace(/^@/, '')
    .replace(/\//g, '_')
    .replace(/[^a-z0-9_.-]/gi, '-');

  const mdPath   = path.join(outDir, `disclosure-${safeName}.md`);
  const jsonPath = path.join(outDir, `disclosure-${safeName}.json`);

  fs.writeFileSync(mdPath,   renderDisclosureDraft(draft),      'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(draft, null, 2),    'utf8');

  return mdPath;
}

module.exports = {
  DISCLOSURE_STATUS,
  buildDisclosureDraft,
  renderDisclosureDraft,
  writeDisclosureDraft,
};
