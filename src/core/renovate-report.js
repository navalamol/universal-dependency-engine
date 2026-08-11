'use strict';

const fs = require('fs');
const path = require('path');
const { CATEGORIES } = require('./renovate-classifier');

const CATEGORY_LABELS = {
  [CATEGORIES.COVERED_PHASE_A]:       'Covered by mendfix Phase A (safe to close)',
  [CATEGORIES.COVERED_PHASE_B]:       'Covered by mendfix Phase B (review then close)',
  [CATEGORIES.DISCARDED_MAJOR_BUMP]:  'Discarded - Major bump (keep open, needs compat check)',
  [CATEGORIES.DISCARDED_MULTI_MAJOR]: 'Discarded - Multi-major conflict (keep open, manual nested overrides required)',
  [CATEGORIES.DISCARDED_NO_FIX]:      'Discarded - No fix available (keep open)',
  [CATEGORIES.RENOVATE_INSUFFICIENT]: 'Renovate insufficient (version too low for CVE fix)',
  [CATEGORIES.NOT_IN_MEND_REPORT]:    'Not in Mend report (out of scope)',
};

function prLink(pr) {
  return `[#${pr.number}](${pr.html_url})`;
}

function cveList(phasedItem) {
  if (!phasedItem) return '-';
  return phasedItem.cves.map(c => c.id).join(', ') || '-';
}

function renderCategorySection(label, items) {
  if (items.length === 0) return '';

  const rows = items.map(c => {
    const pkg = c.parsed ? c.parsed.packageName : '-';
    const renovateV = c.parsed ? c.parsed.proposedVersion : '-';
    const mendV = c.phasedItem ? (c.phasedItem.recommendedVersion || 'no fix') : '-';
    const cves = cveList(c.phasedItem);
    const action = c.actionTaken || '-';
    return `| ${prLink(c.pr)} | ${c.pr.title} | ${pkg} | ${renovateV} | ${mendV} | ${cves} | ${action} |`;
  });

  return [
    `### ${label}`,
    '',
    '| PR | Title | Package | Renovate v | mendfix v | CVEs | Action Taken |',
    '|----|-------|---------|-----------|-----------|------|-------------|',
    ...rows,
    '',
  ].join('\n');
}

function renderRepoSection(repoResult) {
  const { repoName, org, classifiedPRs, stats, errors } = repoResult;
  const lines = [`## ${org}/${repoName}`, ''];

  const byCategory = {};
  for (const cat of Object.values(CATEGORIES)) byCategory[cat] = [];
  for (const c of classifiedPRs) {
    if (byCategory[c.category]) byCategory[c.category].push(c);
  }

  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    lines.push(renderCategorySection(label, byCategory[cat] || []));
  }

  if (errors && errors.length > 0) {
    lines.push('### Errors', '');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderSummaryTable(repoResults) {
  const header = [
    '| Repo | Total PRs | Phase A | Phase B | Major Bump | Multi-Major | No Fix | Insufficient | Out of Scope |',
    '|------|-----------|---------|---------|------------|------------|--------|-------------|-------------|',
  ];
  const rows = repoResults.map(r => {
    const s = r.stats || {};
    return `| ${r.org}/${r.repoName} | ${s.total || 0} | ${s.coveredA || 0} | ${s.coveredB || 0} | ${s.majorBump || 0} | ${s.multiMajor || 0} | ${s.noFix || 0} | ${s.insufficient || 0} | ${s.notInReport || 0} |`;
  });
  return [...header, ...rows].join('\n');
}

/**
 * Generate the markdown report string for all repos.
 */
function generateMarkdown(repoResults, runDate) {
  const lines = [
    `# Renovate PR Workflow Report`,
    ``,
    `Run date: ${runDate}`,
    ``,
    `## Summary`,
    ``,
    renderSummaryTable(repoResults),
    ``,
  ];

  for (const repoResult of repoResults) {
    lines.push(renderRepoSection(repoResult));
  }

  return lines.join('\n');
}

/**
 * Write markdown and JSON reports to outDir.
 */
function writeReport(repoResults, outDir, runDate) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const md = generateMarkdown(repoResults, runDate);
  fs.writeFileSync(path.join(outDir, 'renovate-workflow-report.md'), md, 'utf8');

  const json = {
    runDate,
    repos: repoResults.map(r => ({
      repo: `${r.org}/${r.repoName}`,
      stats: r.stats,
      errors: r.errors || [],
      prs: r.classifiedPRs.map(c => ({
        number: c.pr.number,
        title: c.pr.title,
        url: c.pr.html_url,
        packageName: c.parsed ? c.parsed.packageName : null,
        proposedVersion: c.parsed ? c.parsed.proposedVersion : null,
        category: c.category,
        reason: c.reason,
        mendVersion: c.phasedItem ? c.phasedItem.recommendedVersion : null,
        cves: c.phasedItem ? c.phasedItem.cves.map(cv => cv.id) : [],
        actionTaken: c.actionTaken || null,
      })),
    })),
  };

  fs.writeFileSync(
    path.join(outDir, 'renovate-workflow-report.json'),
    JSON.stringify(json, null, 2),
    'utf8'
  );
}

module.exports = { generateMarkdown, writeReport };
