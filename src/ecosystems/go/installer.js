'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TIMEOUT_MS = 120000;

// ─── Snapshot / restore ──────────────────────────────────────────────────────

function snapshotFiles(filePaths) {
  const snapshots = {};
  for (const p of filePaths) {
    if (fs.existsSync(p)) {
      snapshots[p] = fs.readFileSync(p, 'utf8');
    }
  }
  return snapshots;
}

function restoreFiles(snapshots) {
  for (const [p, content] of Object.entries(snapshots)) {
    fs.writeFileSync(p, content);
  }
}

// ─── go mod tidy ─────────────────────────────────────────────────────────────

/**
 * Run `go mod tidy` in the project directory.
 * Returns { success, error? }.
 */
function runGoModTidy(projectDir) {
  try {
    execSync('go mod tidy', { cwd: projectDir, timeout: TIMEOUT_MS, stdio: 'pipe' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr ? err.stderr.toString() : err.message };
  }
}

/**
 * Run `go mod verify` to confirm module checksums are valid.
 */
function runGoModVerify(projectDir) {
  try {
    execSync('go mod verify', { cwd: projectDir, timeout: TIMEOUT_MS, stdio: 'pipe' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr ? err.stderr.toString() : err.message };
  }
}

// ─── Version verification ────────────────────────────────────────────────────

/**
 * Verify installed module versions by parsing `go list -m all` output.
 * Returns mismatches[].
 */
function verifyFixVersions(phaseAItems, projectDir) {
  let moduleList;
  try {
    const out  = execSync('go list -m all', { cwd: projectDir, timeout: 30000, stdio: 'pipe' }).toString();
    moduleList = new Map();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(' ');
      if (parts.length >= 2) {
        moduleList.set(parts[0], parts[1].replace(/^v/, ''));
      }
    }
  } catch {
    return [];
  }

  const mismatches = [];
  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const installed = moduleList.get(item.libraryName);
    if (!installed) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: 'not found' });
    } else if (installed !== item.recommendedVersion) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: installed });
    }
  }
  return mismatches;
}

module.exports = { snapshotFiles, restoreFiles, runGoModTidy, runGoModVerify, verifyFixVersions };
