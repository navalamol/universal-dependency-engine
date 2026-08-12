'use strict';

const fs = require('fs');

// ─── Entry shape ─────────────────────────────────────────────────────────────
// { resolvedVersion: string, dev: boolean, requires: {}, parents: [] }
// go.mod has no parent/consumer data in the flat require block, so parents
// and requires are always empty. go.sum is checksum-only — we parse go.mod.

function makeEntry(version, dev = false) {
  return { resolvedVersion: version, dev, requires: {}, parents: [] };
}

// ─── go.mod parser ────────────────────────────────────────────────────────────
// Handles:
//   require module/path v1.2.3
//   require (
//     module/path v1.2.3
//     module/path v1.2.3 // indirect
//   )
//   replace old/module => new/module v1.2.3  (stored under old name)

function parseGoMod(content) {
  const depMap   = new Map();
  const replaces = new Map(); // old → new canonical version

  const lines = content.split('\n');
  let inRequire = false;
  let inReplace = false;

  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim(); // strip comments

    if (line === 'require (') { inRequire = true; inReplace = false; continue; }
    if (line === 'replace (') { inReplace = true; inRequire = false; continue; }
    if (line === ')') { inRequire = false; inReplace = false; continue; }

    if (inRequire) {
      const m = line.match(/^(\S+)\s+v([^\s]+)/);
      if (!m) continue;
      const [, modPath, version] = m;
      const name = normalizeGoModule(modPath);
      if (!depMap.has(name)) depMap.set(name, []);
      depMap.get(name).push(makeEntry(version));
      continue;
    }

    if (inReplace) {
      // old/module v1.0.0 => new/module v1.2.3
      const m = line.match(/^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+v(\S+)/);
      if (m) replaces.set(normalizeGoModule(m[1]), m[3]);
      continue;
    }

    // Single-line require: require module/path v1.2.3
    const reqM = line.match(/^require\s+(\S+)\s+v(\S+)/);
    if (reqM) {
      const name = normalizeGoModule(reqM[1]);
      if (!depMap.has(name)) depMap.set(name, []);
      depMap.get(name).push(makeEntry(reqM[2]));
    }
  }

  // Apply replaces: update resolvedVersion for replaced modules
  for (const [name, replacedVersion] of replaces) {
    if (depMap.has(name)) {
      for (const e of depMap.get(name)) {
        e.resolvedVersion = replacedVersion;
        e.replaced        = true;
      }
    }
  }

  return depMap;
}

/**
 * Normalize a Go module path to a short name used as the dep-tree key.
 * We keep the full path because Go modules are path-based identifiers.
 */
function normalizeGoModule(modPath) {
  return modPath.toLowerCase();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse go.mod (or go.sum) into a DepTree Map<modulePath, Entry[]>.
 */
function parseLockFile(lockFilePath) {
  const content  = fs.readFileSync(lockFilePath, 'utf8');
  const basename = require('path').basename(lockFilePath).toLowerCase();

  if (basename === 'go.sum') {
    // go.sum only has checksums; fall back to adjacent go.mod
    const goModPath = lockFilePath.replace(/go\.sum$/, 'go.mod');
    if (fs.existsSync(goModPath)) {
      return parseGoMod(fs.readFileSync(goModPath, 'utf8'));
    }
    return new Map();
  }

  return parseGoMod(content);
}

/**
 * Parse go.mod and return the replace directives as Map<oldModule, newVersion>.
 */
function parseReplaceDirectives(goModPath) {
  const content  = fs.readFileSync(goModPath, 'utf8');
  const replaces = new Map();
  const lines    = content.split('\n');
  let inReplace  = false;

  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === 'replace (') { inReplace = true; continue; }
    if (line === ')' && inReplace) { inReplace = false; continue; }

    if (inReplace) {
      const m = line.match(/^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)\s+v(\S+)/);
      if (m) replaces.set(m[1], m[3]);
    } else {
      const m = line.match(/^replace\s+(\S+)(?:\s+v\S+)?\s+=>\s+\S+\s+v(\S+)/);
      if (m) replaces.set(m[1], m[2]);
    }
  }

  return replaces;
}

module.exports = { parseLockFile, parseGoMod, parseReplaceDirectives, normalizeGoModule };
