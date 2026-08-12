'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_FILE = '.mend-manifest.json';

// ─── Directory.Packages.props writer ─────────────────────────────────────────
// Central Package Management (CPM) is the preferred modern approach.
// A PackageVersion entry controls the version globally; PackageReference in
// individual .csproj files omit the Version attribute.
//
// For projects not using CPM, we fall back to patching PackageReference entries
// in the .csproj file directly.

/**
 * Build a Directory.Packages.props XML snippet for Phase A/B items.
 */
function buildPackagesPropsPatch(items) {
  const eligible = items.filter(i => i.recommendedVersion);
  if (eligible.length === 0) return '';
  const lines = eligible.map(i =>
    `    <PackageVersion Include="${i.libraryName}" Version="${i.recommendedVersion}" />`
  );
  return [
    '<!-- mendfix Phase patch — add to Directory.Packages.props <ItemGroup> -->',
    '<ItemGroup>',
    ...lines,
    '</ItemGroup>',
  ].join('\n');
}

/**
 * Write a phase-specific XML snippet to outDir.
 */
function writePackagesPropsPatch(phasedPlan, outDir, phase) {
  const items = phasedPlan.filter(r => r.phase === phase && r.recommendedVersion);
  if (items.length === 0) return null;
  const content  = buildPackagesPropsPatch(items);
  const filename = phase === 'A' ? 'phase-a-packages-props.xml' : 'phase-b-packages-props.xml';
  const outPath  = path.join(outDir, filename);
  fs.writeFileSync(outPath, content);
  return outPath;
}

/**
 * Apply version pins to an existing Directory.Packages.props or .csproj file.
 * Updates existing PackageVersion/PackageReference Version attributes in-place.
 * Appends new PackageVersion entries for packages not already present.
 */
function applyVersionPins(targetPath, phaseAItems) {
  let content   = fs.readFileSync(targetPath, 'utf8');
  const patched = new Set();

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const name    = item.libraryName;
    const version = item.recommendedVersion;

    // Match PackageVersion or PackageReference with this name, update Version attr
    const updated = content.replace(
      new RegExp(
        `(<Package(?:Version|Reference)\\s[^>]*Include="${escapeRe(name)}"[^>]*\\s)Version="[^"]*"`,
        'gi'
      ),
      `$1Version="${version}"`
    );

    if (updated !== content) {
      content = updated;
      patched.add(name.toLowerCase());
    }
  }

  // Append missing PackageVersion entries before </ItemGroup> or </Project>
  const remaining = phaseAItems.filter(i => i.recommendedVersion && !patched.has(i.libraryName.toLowerCase()));
  if (remaining.length > 0) {
    const newLines = remaining.map(i =>
      `  <PackageVersion Include="${i.libraryName}" Version="${i.recommendedVersion}" />`
    ).join('\n');
    // Insert before closing </ItemGroup> or </Project>
    if (content.includes('</ItemGroup>')) {
      content = content.replace(
        /(<\/ItemGroup>)/,
        `${newLines}\n$1`
      );
    } else {
      content = content.replace('</Project>', `  <ItemGroup>\n${newLines}\n  </ItemGroup>\n</Project>`);
    }
  }

  fs.writeFileSync(targetPath, content);
}

// ─── Manual review ───────────────────────────────────────────────────────────

function buildManualReview(phaseCItems) {
  const lines = [
    '# Phase C — Manual Review (.NET)',
    '',
    'These items require manual action. Major version bumps may include breaking API changes.',
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
    ecosystem: 'dotnet',
    timestamp: new Date().toISOString(),
    phaseA:    phaseAItems.map(i => ({ name: i.libraryName, version: i.recommendedVersion })),
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

function detectManualChanges(targetPath, phaseAItems) {
  if (!fs.existsSync(targetPath)) return [];
  const content   = fs.readFileSync(targetPath, 'utf8');
  const conflicts = [];
  for (const item of phaseAItems) {
    const m = content.match(
      new RegExp(`Include="${escapeRe(item.libraryName)}"[^>]*Version="([^"]+)"`, 'i')
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
  buildPackagesPropsPatch,
  writePackagesPropsPatch,
  applyVersionPins,
  buildManualReview,
  saveManifest,
  detectManualChanges,
};
