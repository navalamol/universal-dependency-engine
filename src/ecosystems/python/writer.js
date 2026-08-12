'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_FILE = '.mend-manifest.json';

// ─── requirements.txt writer ────────────────────────────────────────────────

/**
 * Build a requirements.txt patch: lines of "name==version" for each item.
 */
function buildRequirementsPatch(items) {
  return items
    .filter(i => i.recommendedVersion)
    .map(i => `${i.libraryName}==${i.recommendedVersion}`)
    .join('\n');
}

/**
 * Apply version pins to an existing requirements.txt.
 * Updates existing pinned lines; appends new pins for packages not present.
 * Returns the new file content.
 */
function applyRequirementsPins(content, items) {
  const pins = new Map(
    items.filter(i => i.recommendedVersion).map(i => [i.libraryName.toLowerCase(), i.recommendedVersion])
  );

  const lines  = content.split('\n');
  const patched = new Set();

  const updated = lines.map(raw => {
    const line    = raw.split('#')[0].trim();
    const m       = line.match(/^([A-Za-z0-9_.\-]+)([=><~!]+.*)?$/);
    if (!m) return raw;
    const key = m[1].toLowerCase();
    if (!pins.has(key)) return raw;
    patched.add(key);
    const comment = raw.includes('#') ? '  # ' + raw.split('#').slice(1).join('#').trim() : '';
    return `${m[1]}==${pins.get(key)}${comment}`;
  });

  // Append any packages not already in the file
  for (const [name, version] of pins) {
    if (!patched.has(name)) {
      updated.push(`${name}==${version}`);
    }
  }

  return updated.join('\n');
}

/**
 * Write a phase-specific patch file to outDir.
 * Returns the file path, or null if nothing to write.
 */
function writeRequirementsPatch(phasedPlan, outDir, phase) {
  const items = phasedPlan.filter(r => r.phase === phase && r.recommendedVersion);
  if (items.length === 0) return null;

  const content = [
    `# mendfix — Phase ${phase} pins. Add these to your requirements.txt.`,
    buildRequirementsPatch(items),
  ].join('\n');

  const filename = phase === 'A' ? 'phase-a-requirements.txt' : 'phase-b-requirements.txt';
  const outPath  = path.join(outDir, filename);
  fs.writeFileSync(outPath, content);
  return outPath;
}

/**
 * Apply Phase A pins directly to a requirements.txt file.
 */
function applyPinsToRequirements(requirementsPath, phaseAItems) {
  const content    = fs.readFileSync(requirementsPath, 'utf8');
  const newContent = applyRequirementsPins(content, phaseAItems);
  fs.writeFileSync(requirementsPath, newContent);
}

// ─── pyproject.toml writer ──────────────────────────────────────────────────

/**
 * Apply version pins to pyproject.toml [tool.poetry.dependencies] or
 * [project.dependencies] section.
 * Strategy: regex-replace existing version constraints for matching packages.
 */
function applyPinsToPyprojectToml(pyprojectPath, phaseAItems) {
  let content = fs.readFileSync(pyprojectPath, 'utf8');

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const name    = item.libraryName;
    const version = item.recommendedVersion;

    // Poetry style: name = "^1.2.3" or name = { version = "^1.2.3", ... }
    content = content.replace(
      new RegExp(`^(\\s*${escapeRe(name)}\\s*=\\s*)["'][^"']*["']`, 'gim'),
      `$1"^${version}"`
    );
    // PEP 621 style in [project.dependencies]: "name>=1.0"
    content = content.replace(
      new RegExp(`"${escapeRe(name)}[^"]*"`, 'gi'),
      `"${name}>=${version}"`
    );
  }

  fs.writeFileSync(pyprojectPath, content);
}

// ─── Manual review ──────────────────────────────────────────────────────────

function buildManualReview(phaseCItems) {
  const lines = [
    '# Phase C — Manual Review (Python)',
    '',
    'These items require manual action. Major version bumps must be tested explicitly.',
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

// ─── Manifest ───────────────────────────────────────────────────────────────

function saveManifest(outDir, phaseAItems) {
  const manifest = {
    tool:      'mendfix',
    ecosystem: 'python',
    timestamp: new Date().toISOString(),
    phaseA:    phaseAItems.map(i => ({ name: i.libraryName, version: i.recommendedVersion })),
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

function detectManualChanges(requirementsPath, phaseAItems) {
  if (!fs.existsSync(requirementsPath)) return [];
  const content  = fs.readFileSync(requirementsPath, 'utf8');
  const conflicts = [];
  for (const item of phaseAItems) {
    const m = content.match(new RegExp(`^${escapeRe(item.libraryName)}==([^\\s]+)`, 'im'));
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
  buildRequirementsPatch,
  applyRequirementsPins,
  writeRequirementsPatch,
  applyPinsToRequirements,
  applyPinsToPyprojectToml,
  buildManualReview,
  saveManifest,
  detectManualChanges,
};
