'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Entry shape ─────────────────────────────────────────────────────────────
// { resolvedVersion, dev, requires: {}, parents: [] }
// packages.lock.json has a `dependencies` map per TFM (target framework);
// we merge all TFMs. `type: "Direct"` → dev = false, `type: "Dev"` → dev = true.

function makeEntry(resolvedVersion, dev = false, requires = {}) {
  return { resolvedVersion, dev, requires, parents: [] };
}

// ─── packages.lock.json ───────────────────────────────────────────────────────
// NuGet lock file v1 format.
function parsePackagesLockJson(content) {
  const lock   = JSON.parse(content);
  const depMap = new Map();

  // Collect across all target frameworks (keys under "dependencies")
  const tfmMap = lock.dependencies || {};
  for (const [, pkgs] of Object.entries(tfmMap)) {
    for (const [rawName, meta] of Object.entries(pkgs)) {
      const name    = rawName.toLowerCase();
      const version = meta.resolved || '';
      if (!version) continue;
      const dev     = meta.type === 'Dev' || meta.type === 'DevDependency';
      const requires = {};
      if (meta.dependencies && typeof meta.dependencies === 'object') {
        for (const [dep, ver] of Object.entries(meta.dependencies)) {
          requires[dep.toLowerCase()] = ver;
        }
      }
      // Dedupe across TFMs — keep the first entry per name per version
      const existing = depMap.get(name);
      if (existing) {
        if (!existing.find(e => e.resolvedVersion === version)) {
          existing.push(makeEntry(version, dev, requires));
        }
      } else {
        depMap.set(name, [makeEntry(version, dev, requires)]);
      }
    }
  }

  // Build parents reverse index
  for (const [pkgName, entries] of depMap) {
    for (const entry of entries) {
      for (const [dep, range] of Object.entries(entry.requires)) {
        if (depMap.has(dep)) {
          for (const depEntry of depMap.get(dep)) {
            depEntry.parents.push({ name: pkgName, range });
          }
        }
      }
    }
  }

  return depMap;
}

// ─── .csproj / Directory.Packages.props parser ──────────────────────────────
// Parses PackageReference / PackageVersion elements to extract name+version.
// No full dep-graph data; parents/requires are empty.
function parseCsprojXml(content) {
  const depMap = new Map();
  const RE     = /<Package(?:Reference|Version)\s[^>]*Include="([^"]+)"[^>]*Version="([^"]+)"/gi;
  let m;
  while ((m = RE.exec(content)) !== null) {
    const name    = m[1].toLowerCase();
    const version = m[2];
    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push(makeEntry(version));
  }
  return depMap;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a .NET lock/project file into a DepTree Map<packageName, Entry[]>.
 * Supports: packages.lock.json, Directory.Packages.props, *.csproj
 */
function parseLockFile(lockFilePath) {
  const content  = fs.readFileSync(lockFilePath, 'utf8');
  const basename = path.basename(lockFilePath).toLowerCase();

  if (basename === 'packages.lock.json') return parsePackagesLockJson(content);
  // .csproj, Directory.Packages.props, .props
  return parseCsprojXml(content);
}

/**
 * Probe a directory for known .NET dependency files.
 * Prefers packages.lock.json (most complete); falls back to Directory.Packages.props.
 */
function detectLockFile(dir) {
  for (const name of ['packages.lock.json', 'Directory.Packages.props']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { parseLockFile, detectLockFile, parsePackagesLockJson, parseCsprojXml };
