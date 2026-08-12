'use strict';

const fs     = require('fs');
const semver = require('semver');
const { parseLockFile } = require('../ecosystems/npm/lock-parser');

/**
 * Capture a snapshot of every package's resolved version(s) from a lockfile.
 *
 * Returns Map<packageName, string[]> — sorted, deduplicated array of all
 * resolved versions for each package name.  Multiple versions occur when
 * nested node_modules installs land different versions for different consumers.
 *
 * Returns null if the lockfile does not exist (e.g. first-ever install).
 */
function captureGraph(lockFilePath) {
  if (!lockFilePath || !fs.existsSync(lockFilePath)) return null;

  let depTree;
  try { depTree = parseLockFile(lockFilePath); } catch { return null; }

  const snapshot = new Map();
  for (const [name, entries] of depTree) {
    const versions = [...new Set(
      entries.map(e => e.resolvedVersion).filter(v => semver.valid(v))
    )].sort(semver.compare);
    if (versions.length > 0) snapshot.set(name, versions);
  }
  return snapshot;
}

/**
 * Diff two graph snapshots produced by captureGraph().
 *
 * Either argument may be null (first install has no `before`; a clean uninstall
 * has no `after`).  A null `before` treats every package in `after` as added.
 * A null `after` treats every package in `before` as removed.
 *
 * @param {Map<string,string[]>|null} before
 * @param {Map<string,string[]>|null} after
 *
 * @returns {{
 *   added:          Array<{name: string, versions: string[]}>,
 *   removed:        Array<{name: string, versions: string[]}>,
 *   changed:        Array<{name: string, from: string[], to: string[]}>,
 *   unchangedCount: number,
 * }}
 */
function diffGraphs(before, after) {
  const b = before || new Map();
  const a = after  || new Map();

  const added    = [];
  const removed  = [];
  const changed  = [];
  let   unchanged = 0;

  for (const [name, versions] of a) {
    if (!b.has(name)) {
      added.push({ name, versions });
    } else {
      const fromVersions = b.get(name);
      if (versionsEqual(fromVersions, versions)) {
        unchanged++;
      } else {
        changed.push({ name, from: fromVersions, to: versions });
      }
    }
  }

  for (const [name, versions] of b) {
    if (!a.has(name)) {
      removed.push({ name, versions });
    }
  }

  // Sort for deterministic output
  added.sort((x, y) => x.name.localeCompare(y.name));
  removed.sort((x, y) => x.name.localeCompare(y.name));
  changed.sort((x, y) => x.name.localeCompare(y.name));

  return { added, removed, changed, unchangedCount: unchanged };
}

/**
 * Format a diff result as a markdown string suitable for writing to graph-diff.md.
 *
 * @param {{added, removed, changed, unchangedCount}} diff
 * @param {{ reportDate?: string, project?: string }} [meta]
 */
function formatDiff(diff, meta = {}) {
  const date    = meta.reportDate || new Date().toISOString().split('T')[0];
  const project = meta.project    || '';
  const header  = project ? `# Dependency Graph Diff — ${project} — ${date}` : `# Dependency Graph Diff — ${date}`;

  const { added, removed, changed, unchangedCount } = diff;
  const total = added.length + removed.length + changed.length + unchangedCount;

  const lines = [
    header,
    '',
    `**Summary:** ${total} packages total — ` +
      `${changed.length} changed, ${added.length} added, ${removed.length} removed, ${unchangedCount} unchanged`,
    '',
  ];

  if (changed.length > 0) {
    lines.push('## Changed');
    lines.push('');
    lines.push('| Package | Before | After |');
    lines.push('|---------|--------|-------|');
    for (const c of changed) {
      lines.push(`| \`${c.name}\` | ${c.from.join(', ')} | ${c.to.join(', ')} |`);
    }
    lines.push('');
  }

  if (added.length > 0) {
    lines.push('## Added');
    lines.push('');
    lines.push('| Package | Version(s) |');
    lines.push('|---------|-----------|');
    for (const p of added) {
      lines.push(`| \`${p.name}\` | ${p.versions.join(', ')} |`);
    }
    lines.push('');
  }

  if (removed.length > 0) {
    lines.push('## Removed');
    lines.push('');
    lines.push('| Package | Was |');
    lines.push('|---------|-----|');
    for (const p of removed) {
      lines.push(`| \`${p.name}\` | ${p.versions.join(', ')} |`);
    }
    lines.push('');
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push('_No changes to the dependency graph._');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function versionsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

module.exports = { captureGraph, diffGraphs, formatDiff };
