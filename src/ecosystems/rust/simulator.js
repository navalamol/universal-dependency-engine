'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { safeSpawn, validatePackageName, validateVersion } = require('../../core/safe-exec');

const TIMEOUT_MS = 90000;

/**
 * Simulate applying Cargo.toml pins in an isolated temp workspace.
 *
 * @param {string} cargoTomlPath - path to the project's Cargo.toml
 * @param {Array<{name: string, version: string}>} candidates
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{ success: boolean, resolvedVersions: Map<string,string>, error?: string }}
 */
async function simulate(cargoTomlPath, candidates, opts = {}) {
  if (opts.dryRun) return { success: true, resolvedVersions: new Map() };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendfix-rust-sim-'));

  try {
    const projectDir = path.dirname(cargoTomlPath);
    // Copy Cargo.toml (and Cargo.lock if present) to temp dir
    const tmpCargoToml = path.join(tmpDir, 'Cargo.toml');
    fs.copyFileSync(cargoTomlPath, tmpCargoToml);
    const cargoLockSrc = path.join(projectDir, 'Cargo.lock');
    if (fs.existsSync(cargoLockSrc)) {
      fs.copyFileSync(cargoLockSrc, path.join(tmpDir, 'Cargo.lock'));
    }

    // Apply candidate pins to temp Cargo.toml
    const { applyVersionPins } = require('./writer');
    applyVersionPins(tmpCargoToml, candidates.map(c => ({ libraryName: c.name, recommendedVersion: c.version })));

    // Run cargo update to lock at precise versions
    for (const { name, version } of candidates) {
      validatePackageName(name);
      validateVersion(version);
      const result = safeSpawn(
        'cargo',
        ['update', '--manifest-path', tmpCargoToml, '--package', name, '--precise', version],
        { cwd: tmpDir, timeout: TIMEOUT_MS }
      );
      if (!result.success) {
        throw new Error(result.stderr || result.stdout || `cargo update failed (exit ${result.status})`);
      }
    }

    // Collect resolved versions from Cargo.lock
    const tmpLock = path.join(tmpDir, 'Cargo.lock');
    const resolved = new Map();
    if (fs.existsSync(tmpLock)) {
      const { parseCargoLock } = require('./lock-parser');
      const depMap = parseCargoLock(fs.readFileSync(tmpLock, 'utf8'));
      for (const [name, entries] of depMap) {
        if (entries.length > 0) resolved.set(name, entries[0].resolvedVersion);
      }
    }

    return { success: true, resolvedVersions: resolved };
  } catch (err) {
    return { success: false, resolvedVersions: new Map(), error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { simulate };
