'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_FILE = '.mend-manifest.json';

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDependencyXml(item, indent) {
  const pad = ' '.repeat(indent);
  return [
    `${pad}<dependency>`,
    `${pad}  <groupId>${item.groupId}</groupId>`,
    `${pad}  <artifactId>${item.libraryName}</artifactId>`,
    `${pad}  <version>${item.recommendedVersion}</version>`,
    `${pad}</dependency>`,
  ].join('\n');
}

/**
 * Build a standalone <dependencyManagement> XML snippet from Phase A/B items.
 */
function buildPomPatch(items) {
  const eligible = items.filter(i => i.recommendedVersion && i.groupId);
  if (eligible.length === 0) return '';
  const depXmls = eligible.map(i => buildDependencyXml(i, 4));
  return [
    '<dependencyManagement>',
    '  <dependencies>',
    ...depXmls,
    '  </dependencies>',
    '</dependencyManagement>',
  ].join('\n');
}

/**
 * Write a phase-specific XML patch file to outDir.
 * Returns the file path, or null if there is nothing to write.
 */
function writePomPatch(phasedPlan, outDir, phase) {
  const items = phasedPlan.filter(r => r.phase === phase && r.recommendedVersion && r.groupId);
  if (items.length === 0) return null;

  const xmlContent = [
    `<!-- Mend AutoFixer — Phase ${phase} patch. Add these entries to your <dependencyManagement> section. -->`,
    buildPomPatch(items),
  ].join('\n');

  const filePath = path.join(outDir, `phase-${phase.toLowerCase()}-pom-patch.xml`);
  fs.writeFileSync(filePath, xmlContent + '\n');
  return filePath;
}

// Find a <dependency> block containing specific groupId and artifactId and update its <version>.
// Returns { content, found } — replaces only the FIRST matching block.
function updateVersionInBlock(pomContent, groupId, artifactId, newVersion) {
  let found = false;
  const updated = pomContent.replace(
    /<dependency>([\s\S]*?)<\/dependency>/g,
    (fullMatch, inner) => {
      if (found) return fullMatch;
      const hasGroup    = new RegExp(`<groupId>\\s*${escapeRe(groupId)}\\s*<\\/groupId>`).test(inner);
      const hasArtifact = new RegExp(`<artifactId>\\s*${escapeRe(artifactId)}\\s*<\\/artifactId>`).test(inner);
      if (hasGroup && hasArtifact) {
        found = true;
        return fullMatch.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
      }
      return fullMatch;
    }
  );
  return { content: updated, found };
}

// Insert a new <dependency> entry immediately before the closing </dependencies>
// that is inside <dependencyManagement>.
function insertIntoDependencyManagement(pomContent, newDepXml) {
  const dmStart = pomContent.indexOf('<dependencyManagement>');
  if (dmStart === -1) return { content: pomContent, found: false };

  const dmEnd = pomContent.indexOf('</dependencyManagement>', dmStart);
  if (dmEnd === -1) return { content: pomContent, found: false };

  const dmSection = pomContent.slice(dmStart, dmEnd);
  const closingDepsRel = dmSection.lastIndexOf('</dependencies>');
  if (closingDepsRel === -1) return { content: pomContent, found: false };

  const insertAt = dmStart + closingDepsRel;
  return {
    content: pomContent.slice(0, insertAt) + newDepXml + '\n    ' + pomContent.slice(insertAt),
    found: true,
  };
}

/**
 * Apply Phase A fixes directly to a pom.xml file.
 *
 * For each item:
 *   - If a matching <dependency> already exists in <dependencyManagement>, update its <version>.
 *   - If not found there, insert a new <dependency> entry.
 *   - If <dependencyManagement> doesn't exist, create it before </project>.
 *
 * Uses snapshot/restore rollback on error. Writes .mend-manifest.json for idempotency.
 */
function applyPomPatch(phaseAItems, pomPath) {
  if (!fs.existsSync(pomPath)) {
    throw new Error(`pom.xml not found: ${pomPath}`);
  }

  const items = phaseAItems.filter(i => i.recommendedVersion && i.groupId);
  if (items.length === 0) return;

  const originalContent = fs.readFileSync(pomPath, 'utf8');

  try {
    let pomContent = originalContent;
    const hasDM = pomContent.includes('<dependencyManagement>');

    if (hasDM) {
      for (const item of items) {
        const { content, found } = updateVersionInBlock(pomContent, item.groupId, item.libraryName, item.recommendedVersion);
        if (found) {
          pomContent = content;
        } else {
          const depXml = buildDependencyXml(item, 6);
          const result = insertIntoDependencyManagement(pomContent, depXml);
          if (result.found) {
            pomContent = result.content;
          } else {
            console.warn(`  WARN: could not insert ${item.groupId}:${item.libraryName} — <dependencyManagement> structure unrecognized`);
          }
        }
      }
    } else {
      // No <dependencyManagement> — create one before </project>
      const newSection = [
        '',
        '  <dependencyManagement>',
        '    <dependencies>',
        ...items.map(i => buildDependencyXml(i, 6)),
        '    </dependencies>',
        '  </dependencyManagement>',
      ].join('\n');

      if (pomContent.includes('</project>')) {
        pomContent = pomContent.replace('</project>', newSection + '\n</project>');
      } else {
        pomContent += newSection;
      }
    }

    fs.writeFileSync(pomPath, pomContent, 'utf8');

    const manifest = {
      _tool: 'mend-autofixer',
      _date: new Date().toISOString().split('T')[0],
      dependencyManagement: {},
    };
    for (const item of items) {
      manifest.dependencyManagement[`${item.groupId}:${item.libraryName}`] = item.recommendedVersion;
    }
    fs.writeFileSync(
      path.join(path.dirname(pomPath), MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + '\n'
    );
  } catch (err) {
    fs.writeFileSync(pomPath, originalContent, 'utf8');
    throw err;
  }
}

/**
 * Detect items whose pom.xml version was manually changed since the last tool run.
 * Returns conflict objects matching the same shape as install-runner.detectManualChanges.
 */
function detectManualChanges(pomPath, items) {
  const manifestPath = path.join(path.dirname(pomPath), MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }
  if (!manifest.dependencyManagement) return [];

  const pomContent = fs.readFileSync(pomPath, 'utf8');
  const conflicts  = [];

  for (const item of items) {
    const key      = `${item.groupId}:${item.libraryName}`;
    const lastTool = manifest.dependencyManagement[key];
    if (!lastTool) continue;

    const depPattern = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match;
    while ((match = depPattern.exec(pomContent)) !== null) {
      const block = match[1];
      const hasGroup    = new RegExp(`<groupId>\\s*${escapeRe(item.groupId)}\\s*<\\/groupId>`).test(block);
      const hasArtifact = new RegExp(`<artifactId>\\s*${escapeRe(item.libraryName)}\\s*<\\/artifactId>`).test(block);
      if (hasGroup && hasArtifact) {
        const vMatch = block.match(/<version>([^<]+)<\/version>/);
        if (vMatch) {
          const currentVersion = vMatch[1].trim();
          if (currentVersion !== lastTool && currentVersion !== item.recommendedVersion) {
            conflicts.push({ pkgName: key, lastToolVersion: lastTool, currentVersion });
          }
        }
        break;
      }
    }
  }

  return conflicts;
}

module.exports = { buildPomPatch, writePomPatch, applyPomPatch, detectManualChanges };
