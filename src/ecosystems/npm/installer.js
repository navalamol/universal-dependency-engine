'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const semver = require('semver');
const { parseLockFile } = require('./lock-parser');

const MANIFEST_FILE = '.mend-manifest.json';

// Scenario 22 — snapshot/restore for rollback on install failure
function snapshotFiles(filePaths) {
  const snap = {};
  for (const p of filePaths) {
    snap[p] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return snap;
}

function restoreFiles(snapshots) {
  for (const [p, content] of Object.entries(snapshots)) {
    if (content === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, content, 'utf8');
    }
  }
}

// Scenario 5 — update package-lock.json without a full install
function runPackageLockUpdate(dir) {
  const result = spawnSync('npm', ['install', '--legacy-peer-deps', '--package-lock-only'], {
    cwd: dir,
    stdio: 'pipe',
    shell: true,
  });
  return {
    success: result.status === 0,
    stderr:  result.stderr ? result.stderr.toString() : '',
    status:  result.status,
  };
}

// Scenario 5 — confirm each Phase A package resolved to >= fix version in the lock file
function verifyFixVersions(lockFilePath, items) {
  if (!fs.existsSync(lockFilePath)) return [];
  let depMap;
  try { depMap = parseLockFile(lockFilePath); } catch { return []; }

  const failures = [];
  for (const item of items) {
    if (!item.recommendedVersion) continue;
    const entries  = depMap.get(item.libraryName) || [];
    const resolved = entries.map(e => e.resolvedVersion);
    const allFixed = resolved.length > 0 && resolved.every(v =>
      semver.valid(v) && semver.gte(v, item.recommendedVersion)
    );
    if (!allFixed) {
      failures.push({ libraryName: item.libraryName, expected: item.recommendedVersion, resolved });
    }
  }
  return failures;
}

// Scenario 26 — persist what the tool last wrote so future runs can detect manual edits
function _manifestPath(packageJsonPath) {
  return path.join(path.dirname(packageJsonPath), MANIFEST_FILE);
}

function saveManifest(packageJsonPath, overrides, directUpgrades) {
  const manifest = {
    _tool: 'mend-autofixer',
    _date: new Date().toISOString().split('T')[0],
    overrides:      overrides      || {},
    directUpgrades: directUpgrades || {},
  };
  fs.writeFileSync(_manifestPath(packageJsonPath), JSON.stringify(manifest, null, 2) + '\n');
}

// Scenario 26 — compare current overrides against last-written manifest to find manual edits
function detectManualChanges(packageJsonPath, overridesToApply) {
  const mPath = _manifestPath(packageJsonPath);
  if (!fs.existsSync(mPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch { return []; }
  if (!manifest.overrides) return [];

  const pkg     = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const current = pkg.overrides || {};

  const conflicts = [];
  for (const pkgName of Object.keys(overridesToApply)) {
    const lastTool = manifest.overrides[pkgName];
    const now      = current[pkgName];
    // Only a conflict when the tool wrote a value before AND it changed since then
    if (lastTool && now && now !== lastTool) {
      conflicts.push({ pkgName, lastToolVersion: lastTool, currentVersion: now });
    }
  }
  return conflicts;
}

// Run `mvn dependency:resolve` to confirm the pom.xml changes resolve cleanly.
// -B = batch/non-interactive, -q = quiet output.
function runMavenResolve(dir) {
  const result = spawnSync('mvn', ['dependency:resolve', '-B', '-q'], {
    cwd: dir,
    stdio: 'pipe',
    shell: true,
  });
  return {
    success: result.status === 0,
    stderr:  result.stderr ? result.stderr.toString() : '',
    stdout:  result.stdout ? result.stdout.toString() : '',
    status:  result.status,
  };
}

module.exports = {
  snapshotFiles,
  restoreFiles,
  runPackageLockUpdate,
  runMavenResolve,
  verifyFixVersions,
  saveManifest,
  detectManualChanges,
};
