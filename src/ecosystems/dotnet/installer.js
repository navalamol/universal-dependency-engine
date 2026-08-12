'use strict';

const fs           = require('fs');
const { execSync } = require('child_process');

const TIMEOUT_MS = 120000;

function snapshotFiles(filePaths) {
  const snapshots = {};
  for (const p of filePaths) {
    if (fs.existsSync(p)) snapshots[p] = fs.readFileSync(p, 'utf8');
  }
  return snapshots;
}

function restoreFiles(snapshots) {
  for (const [p, content] of Object.entries(snapshots)) fs.writeFileSync(p, content);
}

/**
 * Run `dotnet restore` in the project directory.
 */
function runDotnetRestore(projectDir) {
  try {
    execSync('dotnet restore --nologo -q', { cwd: projectDir, timeout: TIMEOUT_MS, stdio: 'pipe' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr ? err.stderr.toString() : err.message };
  }
}

/**
 * Verify installed package versions via `dotnet list package`.
 * Returns mismatches[].
 */
function verifyFixVersions(phaseAItems, projectDir) {
  let output;
  try {
    output = execSync('dotnet list package', { cwd: projectDir, timeout: 30000, stdio: 'pipe' }).toString();
  } catch {
    return [];
  }

  const mismatches = [];
  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    // Output line: "   > PackageName    requestedVer    resolvedVer"
    const m = output.match(new RegExp(`>\\s+${escapeRe(item.libraryName)}\\s+\\S+\\s+(\\S+)`, 'i'));
    if (!m) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: 'not found' });
    } else if (m[1] !== item.recommendedVersion) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: m[1] });
    }
  }
  return mismatches;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { snapshotFiles, restoreFiles, runDotnetRestore, verifyFixVersions };
