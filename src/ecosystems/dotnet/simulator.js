'use strict';

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const { execSync } = require('child_process');

const TIMEOUT_MS = 60000;

/**
 * Simulate applying version pins to a temp copy of a project and running
 * `dotnet restore --no-cache` to verify resolution.
 *
 * @param {string} targetPath - path to Directory.Packages.props or .csproj
 * @param {Array<{name: string, version: string}>} candidates
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{ success: boolean, error?: string }}
 */
async function simulate(targetPath, candidates, opts = {}) {
  if (opts.dryRun) return { success: true };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendfix-dotnet-sim-'));

  try {
    const content     = fs.readFileSync(targetPath, 'utf8');
    const tmpTarget   = path.join(tmpDir, path.basename(targetPath));
    const projectDir  = path.dirname(targetPath);

    // Copy all project files to temp dir (shallow copy — no subdirs)
    for (const f of fs.readdirSync(projectDir)) {
      const src = path.join(projectDir, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(tmpDir, f));
      }
    }

    // Apply candidate version pins to the temp copy of the target file
    const { applyVersionPins } = require('./writer');
    applyVersionPins(tmpTarget, candidates.map(c => ({ libraryName: c.name, recommendedVersion: c.version })));

    execSync('dotnet restore --nologo -q --no-cache', {
      cwd:     tmpDir,
      timeout: TIMEOUT_MS,
      stdio:   'pipe',
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { simulate };
