'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_FILE = '.mend-manifest.json';

// ─── Cargo.toml version pin writer ───────────────────────────────────────────
// Strategy: update existing version constraints for pinned crates.
// We set an exact version "=X.Y.Z" rather than "^X.Y.Z" because the security
// fix must be at exactly the patched version — not "at least".
//
// Trade-off: exact pins block cargo from resolving a newer compatible version.
// Users should run `cargo update --precise` after reviewing, then loosen pins.

/**
 * Build a Cargo.toml snippet showing pinned dependencies for Phase A/B items.
 */
function buildCargoTomlPatch(items) {
  const eligible = items.filter(i => i.recommendedVersion);
  if (eligible.length === 0) return '';
  const lines = eligible.map(i => `${i.libraryName} = "=${i.recommendedVersion}"`);
  return ['# mendfix Phase patch — update these in your [dependencies] section', ...lines].join('\n');
}

/**
 * Write a phase-specific Cargo.toml snippet to outDir.
 */
function writeCargoTomlPatch(phasedPlan, outDir, phase) {
  const items = phasedPlan.filter(r => r.phase === phase && r.recommendedVersion);
  if (items.length === 0) return null;
  const content  = buildCargoTomlPatch(items);
  const filename = phase === 'A' ? 'phase-a-cargo-toml.txt' : 'phase-b-cargo-toml.txt';
  const outPath  = path.join(outDir, filename);
  fs.writeFileSync(outPath, content);
  return outPath;
}

/**
 * Apply version pins directly to Cargo.toml.
 * Updates existing version strings; appends new [patch.crates-io] entries
 * for packages not found in [dependencies] / [dev-dependencies].
 */
function applyVersionPins(cargoTomlPath, phaseAItems) {
  let content = fs.readFileSync(cargoTomlPath, 'utf8');
  const patched = new Set();

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const name    = item.libraryName;
    const version = `=${item.recommendedVersion}`;

    // Simple string form: name = "old-version" → name = "=new-version"
    const simpleRE = new RegExp(`^(${escapeRe(name)}\\s*=\\s*)"[^"]+"`, 'gim');
    // Inline table form: name = { version = "old", ... }
    const tableRE  = new RegExp(`^(${escapeRe(name)}\\s*=\\s*\\{[^}]*version\\s*=\\s*)"[^"]+"`, 'gim');

    let updated = content.replace(simpleRE, `$1"${version}"`);
    if (updated === content) updated = content.replace(tableRE, `$1"${version}"`);

    if (updated !== content) {
      content = updated;
      patched.add(name.toLowerCase());
    }
  }

  // Append [patch.crates-io] block for packages not already in Cargo.toml
  const remaining = phaseAItems.filter(i =>
    i.recommendedVersion && !patched.has(i.libraryName.toLowerCase())
  );
  if (remaining.length > 0) {
    const patchBlock = [
      '',
      '# mendfix — packages not found in [dependencies]; using [patch.crates-io]',
      '[patch.crates-io]',
      ...remaining.map(i => `${i.libraryName} = { version = "=${i.recommendedVersion}" }`),
    ].join('\n');
    content = content.trimEnd() + '\n' + patchBlock + '\n';
  }

  fs.writeFileSync(cargoTomlPath, content);
}

// ─── Manual review ───────────────────────────────────────────────────────────

function buildManualReview(phaseCItems) {
  const lines = [
    '# Phase C — Manual Review (Rust)',
    '',
    'These items require manual action. Major version bumps may change APIs.',
    'Check CHANGELOG and update use statements before applying.',
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

// ─── Manifest + conflict detection ──────────────────────────────────────────

function saveManifest(outDir, phaseAItems) {
  const manifest = {
    tool:      'mendfix',
    ecosystem: 'rust',
    timestamp: new Date().toISOString(),
    phaseA:    phaseAItems.map(i => ({ name: i.libraryName, version: i.recommendedVersion })),
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

function detectManualChanges(cargoTomlPath, phaseAItems) {
  if (!fs.existsSync(cargoTomlPath)) return [];
  const content   = fs.readFileSync(cargoTomlPath, 'utf8');
  const conflicts = [];
  for (const item of phaseAItems) {
    const m = content.match(
      new RegExp(`^${escapeRe(item.libraryName)}\\s*=\\s*"[=^~]?([^"]+)"`, 'im')
    );
    if (m) {
      const cur = m[1].replace(/^[=^~]/, '');
      if (cur !== item.recommendedVersion) {
        conflicts.push({ pkgName: item.libraryName, lastToolVersion: item.recommendedVersion, currentVersion: cur });
      }
    }
  }
  return conflicts;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  buildCargoTomlPatch,
  writeCargoTomlPatch,
  applyVersionPins,
  buildManualReview,
  saveManifest,
  detectManualChanges,
};
