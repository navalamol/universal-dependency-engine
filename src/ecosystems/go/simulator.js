'use strict';

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const { execSync } = require('child_process');

const TIMEOUT_MS = 60000;

/**
 * Simulate applying replace directives in an isolated temp GOPATH.
 *
 * @param {string} goModPath - path to the project go.mod
 * @param {Array<{name: string, version: string}>} candidates
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{ success: boolean, resolvedVersions: Map<string,string>, error?: string }}
 */
async function simulate(goModPath, candidates, opts = {}) {
  if (opts.dryRun) {
    return { success: true, resolvedVersions: new Map() };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendfix-go-sim-'));

  try {
    const goModContent = fs.readFileSync(goModPath, 'utf8');
    const goSumPath    = goModPath.replace(/go\.mod$/, 'go.sum');
    const goSumContent = fs.existsSync(goSumPath) ? fs.readFileSync(goSumPath, 'utf8') : '';

    // Copy go.mod + go.sum into temp dir
    const tmpGoMod = path.join(tmpDir, 'go.mod');
    const tmpGoSum = path.join(tmpDir, 'go.sum');
    fs.writeFileSync(tmpGoMod, goModContent);
    fs.writeFileSync(tmpGoSum, goSumContent);

    // Apply replace directives for candidates
    let modContent = goModContent;
    for (const { name, version } of candidates) {
      const newLine  = `replace ${name} => ${name} v${version}`;
      const existing = new RegExp(
        `^(\\s*replace\\s+${escapeRe(name)}.*?=>\\s+\\S+)\\s+v\\S+`,
        'gim'
      );
      if (existing.test(modContent)) {
        modContent = modContent.replace(existing, `$1 v${version}`);
      } else {
        modContent = modContent.trimEnd() + `\n${newLine}\n`;
      }
    }
    fs.writeFileSync(tmpGoMod, modContent);

    // go mod download to resolve without a full build
    execSync('go mod download', {
      cwd:     tmpDir,
      timeout: TIMEOUT_MS,
      stdio:   'pipe',
      env:     { ...process.env, GOPATH: path.join(tmpDir, '.gopath') },
    });

    // Collect resolved versions
    const listOut    = execSync('go list -m all', { cwd: tmpDir, timeout: 15000, stdio: 'pipe' }).toString();
    const resolved   = new Map();
    for (const line of listOut.split('\n')) {
      const parts = line.trim().split(' ');
      if (parts.length >= 2) resolved.set(parts[0], parts[1].replace(/^v/, ''));
    }

    return { success: true, resolvedVersions: resolved };
  } catch (err) {
    return { success: false, resolvedVersions: new Map(), error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { simulate };
