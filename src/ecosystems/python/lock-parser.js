'use strict';

const fs = require('fs');

// ─── Entry shape ────────────────────────────────────────────────────────────
// { resolvedVersion: string, dev: boolean, requires: {}, parents: [] }
// Parents/requires are populated from poetry.lock; requirements.txt and
// Pipfile.lock are flat (no dep-graph data), so those fields are empty.

function makeEntry(resolvedVersion, dev = false, requires = {}) {
  return { resolvedVersion, dev, requires, parents: [] };
}

// ─── poetry.lock ────────────────────────────────────────────────────────────
// TOML-like format; we parse it with a simple state machine (no toml lib dep).
function parsePoetryLock(content) {
  const depMap = new Map();
  const blocks = content.split(/\n\[\[package\]\]/);

  for (const block of blocks) {
    const nameMatch    = block.match(/^name\s*=\s*"([^"]+)"/m);
    const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (!nameMatch || !versionMatch) continue;

    const name    = nameMatch[1].toLowerCase();
    const version = versionMatch[1];

    // Extract [package.dependencies] section → requires map
    const requires = {};
    const depsSection = block.match(/\[package\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (depsSection) {
      for (const line of depsSection[1].split('\n')) {
        const m = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
        if (m) requires[m[1].toLowerCase()] = m[2];
      }
    }

    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push(makeEntry(version, false, requires));
  }

  // Second pass: build parents reverse index
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

// ─── Pipfile.lock ────────────────────────────────────────────────────────────
function parsePipfileLock(content) {
  const lock   = JSON.parse(content);
  const depMap = new Map();

  const addSection = (section, dev) => {
    if (!section || typeof section !== 'object') return;
    for (const [rawName, meta] of Object.entries(section)) {
      if (rawName === '_meta') continue;
      const name    = rawName.toLowerCase();
      const verRaw  = (meta && meta.version) ? meta.version : '';
      const version = verRaw.replace(/^==/, '');
      if (!version) continue;
      if (!depMap.has(name)) depMap.set(name, []);
      depMap.get(name).push(makeEntry(version, dev));
    }
  };

  addSection(lock.default, false);
  addSection(lock.develop, true);

  return depMap;
}

// ─── requirements.txt ───────────────────────────────────────────────────────
// Only pinned lines (==) are parsed; unpinned constraints are skipped.
function parseRequirementsTxt(content) {
  const depMap = new Map();
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9_.\-]+)==([^\s;]+)/);
    if (!m) continue;
    const name    = m[1].toLowerCase();
    const version = m[2];
    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push(makeEntry(version, false));
  }
  return depMap;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a Python lock file into a DepTree.
 * Supported: poetry.lock, Pipfile.lock, requirements.txt
 */
function parseLockFile(lockFilePath) {
  const content  = fs.readFileSync(lockFilePath, 'utf8');
  const basename = require('path').basename(lockFilePath).toLowerCase();

  if (basename === 'poetry.lock') return parsePoetryLock(content);
  if (basename === 'pipfile.lock') return parsePipfileLock(content);
  if (basename.startsWith('requirements')) return parseRequirementsTxt(content);

  // Last-ditch: try each parser in order
  try { return parsePipfileLock(content); } catch {}
  try { return parseRequirementsTxt(content); } catch {}
  return parsePoetryLock(content);
}

/**
 * Detect which Python lock file format is present in a directory.
 * Returns the full path to the first match found, or null.
 */
function detectLockFile(dir) {
  const path = require('path');
  for (const name of ['poetry.lock', 'Pipfile.lock', 'requirements.txt']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { parseLockFile, detectLockFile, parsePoetryLock, parsePipfileLock, parseRequirementsTxt };
