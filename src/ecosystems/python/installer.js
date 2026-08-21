'use strict';

const fs   = require('fs');
const path = require('path');
const { safeSpawn, validatePackageName } = require('../../core/safe-exec');

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

// ─── pip install ─────────────────────────────────────────────────────────────

/**
 * Run pip install -r requirements.txt inside the project directory.
 * Uses the venv pip if a venv is present at ./venv or ./.venv.
 */
function runPipInstall(projectDir, requirementsPath) {
  const venvPip = findVenvPip(projectDir);
  const pip     = venvPip || 'pip';

  const result = safeSpawn(pip, ['install', '-r', requirementsPath, '--quiet'],
    { cwd: projectDir, timeout: TIMEOUT_MS });
  if (!result.success) {
    return { success: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  return { success: true };
}

function findVenvPip(projectDir) {
  const candidates = [
    path.join(projectDir, 'venv', 'Scripts', 'pip.exe'),  // Windows
    path.join(projectDir, 'venv', 'bin', 'pip'),           // Unix
    path.join(projectDir, '.venv', 'Scripts', 'pip.exe'),
    path.join(projectDir, '.venv', 'bin', 'pip'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ─── Version verification ────────────────────────────────────────────────────

/**
 * Verify that installed versions match expected using pip show.
 */
function verifyFixVersions(phaseAItems, projectDir) {
  const venvPip = findVenvPip(projectDir);
  const pip     = venvPip || 'pip';
  const mismatches = [];

  for (const item of phaseAItems) {
    if (!item.recommendedVersion) continue;
    try {
      validatePackageName(item.libraryName);
      const r = safeSpawn(pip, ['show', item.libraryName], { cwd: projectDir, timeout: 15000 });
      const out = r.stdout;
      const m = out.match(/^Version:\s*(.+)$/im);
      if (!m) {
        mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: 'not installed' });
        continue;
      }
      const installed = m[1].trim();
      if (installed !== item.recommendedVersion) {
        mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: installed });
      }
    } catch {
      mismatches.push({ name: item.libraryName, expected: item.recommendedVersion, actual: 'unknown' });
    }
  }

  return mismatches;
}

module.exports = { snapshotFiles, restoreFiles, runPipInstall, verifyFixVersions };
