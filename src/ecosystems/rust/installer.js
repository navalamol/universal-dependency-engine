'use strict';

const fs = require('fs');
const { safeSpawn, validatePackageName, validateVersion } = require('../../core/safe-exec');

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
 * Run `cargo update` for a specific set of crates to lock them at exact versions.
 * Uses `cargo update --package name --precise version` per item.
 */
function runCargoUpdate(phaseAItems, projectDir) {
  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    try {
      validatePackageName(item.libraryName);
      validateVersion(item.recommendedVersion);
    } catch (err) {
      return { success: false, error: `Validation error: ${err.message}` };
    }
    const result = safeSpawn(
      'cargo',
      ['update', '--package', item.libraryName, '--precise', item.recommendedVersion],
      { cwd: projectDir, timeout: TIMEOUT_MS }
    );
    if (!result.success) {
      return { success: false, error: result.stderr || result.stdout || `exit ${result.status}` };
    }
  }
  return { success: true };
}

/**
 * Run `cargo check` to verify the workspace compiles with updated Cargo.lock.
 */
function runCargoCheck(projectDir) {
  const result = safeSpawn('cargo', ['check', '--quiet'], { cwd: projectDir, timeout: TIMEOUT_MS });
  if (!result.success) {
    return { success: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  return { success: true };
}

/**
 * Verify installed crate versions from Cargo.lock.
 * Returns mismatches[].
 */
function verifyFixVersions(phaseAItems, projectDir) {
  const cargoLockPath = require('path').join(projectDir, 'Cargo.lock');
  if (!fs.existsSync(cargoLockPath)) return [];

  const content  = fs.readFileSync(cargoLockPath, 'utf8');
  const { parseCargoLock } = require('./lock-parser');
  const depMap   = parseCargoLock(content);
  const mismatches = [];

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    const entries = depMap.get(item.libraryName.toLowerCase()) || [];
    if (entries.length === 0) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: 'not found' });
    } else if (!entries.some(e => e.resolvedVersion === item.recommendedVersion)) {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: entries[0].resolvedVersion });
    }
  }
  return mismatches;
}

module.exports = { snapshotFiles, restoreFiles, runCargoUpdate, runCargoCheck, verifyFixVersions };
