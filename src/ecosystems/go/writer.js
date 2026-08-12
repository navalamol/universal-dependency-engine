'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_FILE = '.mend-manifest.json';

// ─── go.mod replace-directive writer ─────────────────────────────────────────
//
// Strategy: for each Phase A item, add or update a `replace` directive in go.mod.
//
//   replace github.com/old/dep => github.com/old/dep v1.2.3
//
// We do NOT edit the require block — replace directives are the safest non-breaking
// override that satisfies go mod's resolution rules without touching the require
// stanza that may be managed by CI tooling.

/**
 * Build a standalone go.mod snippet showing the replace directives for Phase A/B.
 */
function buildGoModPatch(items) {
  const eligible = items.filter(i => i.recommendedVersion);
  if (eligible.length === 0) return '';
  const directives = eligible.map(i =>
    `\treplace ${i.libraryName} => ${i.libraryName} v${i.recommendedVersion}`
  );
  return ['// mendfix replace directives — add to your go.mod', ...directives].join('\n');
}

/**
 * Write a phase-specific go.mod snippet file to outDir.
 * Returns the file path, or null if nothing to write.
 */
function writeGoModPatch(phasedPlan, outDir, phase) {
  const items = phasedPlan.filter(r => r.phase === phase && r.recommendedVersion);
  if (items.length === 0) return null;

  const content  = buildGoModPatch(items);
  const filename = phase === 'A' ? 'phase-a-go-mod.txt' : 'phase-b-go-mod.txt';
  const outPath  = path.join(outDir, filename);
  fs.writeFileSync(outPath, content);
  return outPath;
}

/**
 * Apply replace directives directly to a go.mod file.
 * Adds missing directives and updates existing ones.
 */
function applyReplaceDirectives(goModPath, phaseAItems) {
  let content = fs.readFileSync(goModPath, 'utf8');

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const mod     = item.libraryName;
    const version = item.recommendedVersion;
    const newLine = `replace ${mod} => ${mod} v${version}`;

    // Update existing replace directive for this module
    const existing = new RegExp(
      `^(\\s*replace\\s+${escapeRe(mod)}(?:\\s+v\\S+)?\\s+=>\\s+\\S+)\\s+v\\S+`,
      'gim'
    );
    if (existing.test(content)) {
      content = content.replace(existing, `$1 v${version}`);
    } else {
      // Append before the last blank line or at end of file
      if (content.includes('\nreplace (')) {
        // Inside a replace block: insert before closing paren
        content = content.replace(
          /^(\s*\))\s*$/m,
          `\t${newLine}\n$1`
        );
      } else {
        content = content.trimEnd() + `\n\n${newLine}\n`;
      }
    }
  }

  fs.writeFileSync(goModPath, content);
}

// ─── Manual review ───────────────────────────────────────────────────────────

function buildManualReview(phaseCItems) {
  const lines = [
    '# Phase C — Manual Review (Go)',
    '',
    'These items require manual action. Major module version changes may require',
    'import path changes (e.g. github.com/foo/bar/v2) and cannot be automated.',
    '',
  ];
  for (const item of phaseCItems) {
    lines.push(`## ${item.libraryName}`);
    lines.push(`- Current: ${item.currentVersion}`);
    lines.push(`- Recommended: ${item.recommendedVersion || 'NO FIX'}`);
    lines.push(`- Reason: ${item.justification}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

function saveManifest(outDir, phaseAItems) {
  const manifest = {
    tool:      'mendfix',
    ecosystem: 'go',
    timestamp: new Date().toISOString(),
    phaseA:    phaseAItems.map(i => ({ name: i.libraryName, version: i.recommendedVersion })),
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

function detectManualChanges(goModPath, phaseAItems) {
  if (!fs.existsSync(goModPath)) return [];
  const content   = fs.readFileSync(goModPath, 'utf8');
  const conflicts = [];
  for (const item of phaseAItems) {
    const m = content.match(
      new RegExp(`replace\\s+${escapeRe(item.libraryName)}.*?=>\\s+\\S+\\s+v(\\S+)`, 'im')
    );
    if (m && m[1] !== item.recommendedVersion) {
      conflicts.push({ pkgName: item.libraryName, lastToolVersion: item.recommendedVersion, currentVersion: m[1] });
    }
  }
  return conflicts;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  buildGoModPatch,
  writeGoModPatch,
  applyReplaceDirectives,
  buildManualReview,
  saveManifest,
  detectManualChanges,
};
