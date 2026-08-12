'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Entry shape ─────────────────────────────────────────────────────────────
// Cargo.lock TOML v3 format:
//   [[package]]
//   name = "serde"
//   version = "1.0.152"
//   dependencies = ["serde_derive 1.0.152 (registry+...)", ...]
//
// v3 (Cargo 1.72+) uses name-only dependency lines; v1/v2 use "name version (source)".

function makeEntry(version, dev = false, requires = {}) {
  return { resolvedVersion: version, dev, requires, parents: [] };
}

function parseCargoLock(content) {
  const depMap = new Map();

  // Split on [[package]] boundaries (TOML array-of-tables)
  const blocks = content.split(/\n\[\[package\]\]/);

  for (const block of blocks) {
    const nameMatch    = block.match(/^name\s*=\s*"([^"]+)"/m);
    const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (!nameMatch || !versionMatch) continue;

    const name    = nameMatch[1].toLowerCase();
    const version = versionMatch[1];

    // Parse dependencies array (may span multiple lines with TOML array syntax)
    const requires = {};
    const depsMatch = block.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (depsMatch) {
      const depLines = depsMatch[1].match(/"([^"]+)"/g) || [];
      for (const quoted of depLines) {
        const dep = quoted.replace(/"/g, '').split(' ')[0].toLowerCase();
        if (dep) requires[dep] = '*'; // Cargo.lock has resolved versions, not ranges
      }
    }

    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push(makeEntry(version, false, requires));
  }

  // Build parents reverse index
  for (const [pkgName, entries] of depMap) {
    for (const entry of entries) {
      for (const dep of Object.keys(entry.requires)) {
        if (depMap.has(dep)) {
          for (const depEntry of depMap.get(dep)) {
            if (!depEntry.parents.find(p => p.name === pkgName)) {
              depEntry.parents.push({ name: pkgName, range: '*' });
            }
          }
        }
      }
    }
  }

  return depMap;
}

// ─── Cargo.toml parser ───────────────────────────────────────────────────────
// Minimal: extract [dependencies] and [dev-dependencies] version pins.
function parseCargoToml(content) {
  const depMap      = new Map();
  const depsRE      = /^\[(?:dev-)?dependencies\]/gm;
  const nextSection = /^\[/m;

  let m;
  while ((m = depsRE.exec(content)) !== null) {
    const isDev = content.slice(m.index, m.index + 20).includes('dev-');
    const rest  = content.slice(m.index + m[0].length);
    const end   = rest.search(nextSection);
    const block = end === -1 ? rest : rest.slice(0, end);

    for (const line of block.split('\n')) {
      // name = "1.0" or name = { version = "1.0", ... }
      const simple   = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);
      const tableVer = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
      const match    = simple || tableVer;
      if (!match) continue;
      const name    = match[1].toLowerCase();
      const version = match[2].replace(/^[^0-9]*/, ''); // strip leading ^ ~ >= etc.
      if (!depMap.has(name)) depMap.set(name, []);
      depMap.get(name).push(makeEntry(version, isDev));
    }
  }

  return depMap;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse Cargo.lock or Cargo.toml into a DepTree.
 */
function parseLockFile(lockFilePath) {
  const content  = fs.readFileSync(lockFilePath, 'utf8');
  const basename = path.basename(lockFilePath).toLowerCase();

  if (basename === 'cargo.lock') return parseCargoLock(content);
  if (basename === 'cargo.toml') return parseCargoToml(content);
  return parseCargoLock(content); // default
}

module.exports = { parseLockFile, parseCargoLock, parseCargoToml };
