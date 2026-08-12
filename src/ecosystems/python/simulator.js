'use strict';

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const { execSync } = require('child_process');

const TIMEOUT_MS = 60000;

/**
 * Simulate installing a requirements set in an isolated temp venv.
 *
 * @param {string} baseRequirementsPath - path to original requirements.txt
 * @param {Array<{name: string, version: string}>} candidates - pins to apply
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{ success: boolean, resolvedVersions: Map<string,string>, error?: string }}
 */
async function simulate(baseRequirementsPath, candidates, opts = {}) {
  if (opts.dryRun) {
    return { success: true, resolvedVersions: new Map() };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendfix-py-sim-'));

  try {
    // Build a requirements.txt with candidates pinned
    const base = fs.existsSync(baseRequirementsPath)
      ? fs.readFileSync(baseRequirementsPath, 'utf8')
      : '';

    const pinMap = new Map(candidates.map(c => [c.name.toLowerCase(), c.version]));
    const lines  = base.split('\n').map(raw => {
      const m = raw.split('#')[0].trim().match(/^([A-Za-z0-9_.\-]+)/);
      if (!m) return raw;
      const key = m[1].toLowerCase();
      if (!pinMap.has(key)) return raw;
      pinMap.delete(key); // mark as covered
      return `${m[1]}==${pinMap.get(key) ?? candidates.find(c => c.name.toLowerCase() === key)?.version}`;
    });
    for (const [name, version] of pinMap) {
      lines.push(`${name}==${version}`);
    }

    const reqPath = path.join(tmpDir, 'requirements.txt');
    fs.writeFileSync(reqPath, lines.join('\n'));

    // Create venv
    execSync(`python -m venv "${path.join(tmpDir, 'venv')}"`, { timeout: 30000, stdio: 'pipe' });

    const pip = process.platform === 'win32'
      ? path.join(tmpDir, 'venv', 'Scripts', 'pip.exe')
      : path.join(tmpDir, 'venv', 'bin', 'pip');

    execSync(`"${pip}" install -r "${reqPath}" --quiet`, { timeout: TIMEOUT_MS, stdio: 'pipe' });

    // Collect installed versions
    const freeze  = execSync(`"${pip}" freeze`, { timeout: 15000, stdio: 'pipe' }).toString();
    const resolved = new Map();
    for (const line of freeze.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_.\-]+)==(.+)$/);
      if (m) resolved.set(m[1].toLowerCase(), m[2].trim());
    }

    return { success: true, resolvedVersions: resolved };
  } catch (err) {
    return { success: false, resolvedVersions: new Map(), error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { simulate };
