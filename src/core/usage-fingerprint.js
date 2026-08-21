'use strict';

// D2.1 — API usage fingerprint scanner.
// Scans source files for import/require statements to understand how a package
// is used before migration. Produces a fingerprint that the migration planner
// uses to assess migration effort.
//
// RULES:
//   - No AST evaluation — regex-based, fast, zero dependencies
//   - Only reads files — never mutates source
//   - Limited to configurable file extensions and depth
//   - Returns structured evidence, not human text

const fs   = require('fs');
const path = require('path');

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const DEFAULT_IGNORE     = ['node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output'];
const DEFAULT_MAX_FILES  = 500;

// Patterns to extract import/require statements
const REQUIRE_RE  = /require\(['"`]([^'"`\s]+)['"`]\)/g;
const IMPORT_RE   = /import\s+(?:[\w*{},\s]+\s+from\s+)?['"`]([^'"`\s]+)['"`]/g;
const EXPORT_RE   = /export\s+(?:\*|{[^}]*})\s+from\s+['"`]([^'"`\s]+)['"`]/g;

// ─── scanDirectory ────────────────────────────────────────────────────────────

/**
 * Scan a directory for usages of a specific package.
 *
 * @param {string}   dir         - Root directory to scan
 * @param {string}   packageName - Package name to look for
 * @param {object}   [opts]
 * @param {string[]} [opts.extensions]  - file extensions to scan
 * @param {string[]} [opts.ignore]      - directory names to skip
 * @param {number}   [opts.maxFiles]    - stop after scanning this many files
 * @returns {{
 *   packageName: string,
 *   filesScanned: number,
 *   filesWithUsage: number,
 *   usages: Array<{ file, line, statement, symbols: string[] }>,
 *   symbols: string[],          // deduplicated imported symbols
 *   subpaths: string[],         // deduplicated subpath imports e.g. 'lodash/merge'
 *   limitHit: boolean,
 * }}
 */
function scanDirectory(dir, packageName, opts = {}) {
  const extensions = opts.extensions || DEFAULT_EXTENSIONS;
  const ignore     = opts.ignore     || DEFAULT_IGNORE;
  const maxFiles   = opts.maxFiles   || DEFAULT_MAX_FILES;

  const usages    = [];
  const allFiles  = _collectFiles(dir, extensions, ignore, maxFiles);
  const limitHit  = allFiles.limitHit;

  const symbolSet  = new Set();
  const subpathSet = new Set();

  for (const filePath of allFiles.files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const fileUsages = parseImports(content, filePath, packageName);
    for (const u of fileUsages) {
      usages.push(u);
      for (const s of u.symbols)   symbolSet.add(s);
      if (u.subpath) subpathSet.add(u.subpath);
    }
  }

  const filesWithUsage = new Set(usages.map(u => u.file)).size;

  return {
    packageName,
    filesScanned:  allFiles.files.length,
    filesWithUsage,
    usages,
    symbols:  [...symbolSet].sort(),
    subpaths: [...subpathSet].sort(),
    limitHit,
  };
}

// ─── parseImports ─────────────────────────────────────────────────────────────

/**
 * Parse all import/require statements from file content.
 * Returns only those that reference `targetPackage`.
 *
 * @param {string} content
 * @param {string} filePath   - for output labeling only
 * @param {string} [targetPackage] - if provided, filter to this package only
 * @returns {Array<{ file, line, statement, symbols: string[], subpath: string|null }>}
 */
function parseImports(content, filePath, targetPackage) {
  const results = [];
  const lines   = content.split('\n');

  const patterns = [
    { re: REQUIRE_RE,  type: 'require' },
    { re: IMPORT_RE,   type: 'import'  },
    { re: EXPORT_RE,   type: 'export'  },
  ];

  for (const { re, type } of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      const specifier = match[1];
      const { pkgName, subpath } = _parseSpecifier(specifier);

      if (targetPackage && pkgName !== targetPackage) continue;

      const lineNum = content.slice(0, match.index).split('\n').length;
      const lineSrc = lines[lineNum - 1] || '';

      results.push({
        file:      filePath,
        line:      lineNum,
        statement: lineSrc.trim(),
        type,
        symbols:   _extractSymbols(lineSrc, type),
        subpath,
      });
    }
  }

  // Deduplicate by file+line (same line can match multiple patterns)
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── buildFingerprint ────────────────────────────────────────────────────────

/**
 * Build a concise migration fingerprint from scan results.
 * Summarizes usage patterns to estimate migration effort.
 *
 * @param {object} scanResult  - output of scanDirectory
 * @returns {{
 *   packageName: string,
 *   usageCount: number,
 *   filesWithUsage: number,
 *   symbols: string[],
 *   subpaths: string[],
 *   effortEstimate: 'trivial'|'low'|'medium'|'high',
 *   effortBasis: string,
 * }}
 */
function buildFingerprint(scanResult) {
  const usageCount     = scanResult.usages.length;
  const filesCount     = scanResult.filesWithUsage;
  const symbolCount    = scanResult.symbols.length;

  let effortEstimate;
  let effortBasis;

  if (filesCount === 0) {
    effortEstimate = 'trivial';
    effortBasis    = 'Package not found in source — may be unused or indirect only';
  } else if (filesCount <= 2 && usageCount <= 5) {
    effortEstimate = 'low';
    effortBasis    = `${filesCount} file(s), ${usageCount} usage(s)`;
  } else if (filesCount <= 10 || symbolCount > 5) {
    effortEstimate = 'medium';
    effortBasis    = `${filesCount} file(s), ${symbolCount} symbol(s) imported`;
  } else {
    effortEstimate = 'high';
    effortBasis    = `${filesCount} file(s) — widespread usage across codebase`;
  }

  return {
    packageName:    scanResult.packageName,
    usageCount,
    filesWithUsage: filesCount,
    symbols:        scanResult.symbols,
    subpaths:       scanResult.subpaths,
    effortEstimate,
    effortBasis,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _collectFiles(dir, extensions, ignore, maxFiles) {
  const files    = [];
  let   limitHit = false;

  function walk(curr) {
    if (limitHit) return;
    let entries;
    try { entries = fs.readdirSync(curr, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (limitHit) return;
      const name     = entry.name;
      const fullPath = path.join(curr, name);

      if (entry.isDirectory()) {
        if (!ignore.includes(name)) walk(fullPath);
      } else if (entry.isFile()) {
        if (extensions.includes(path.extname(name))) {
          files.push(fullPath);
          if (files.length >= maxFiles) { limitHit = true; return; }
        }
      }
    }
  }

  walk(dir);
  return { files, limitHit };
}

function _parseSpecifier(specifier) {
  // Handle scoped packages: @scope/name or @scope/name/subpath
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length >= 2) {
      const pkgName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join('/') : null;
      return { pkgName, subpath };
    }
  }
  const slashIdx = specifier.indexOf('/');
  if (slashIdx === -1) return { pkgName: specifier, subpath: null };
  return { pkgName: specifier.slice(0, slashIdx), subpath: specifier.slice(slashIdx + 1) };
}

function _extractSymbols(line, type) {
  const symbols = [];
  if (type === 'require') {
    // const { a, b } = require('pkg') or const x = require('pkg').method
    const destructure = /const\s+\{([^}]+)\}/.exec(line);
    if (destructure) {
      symbols.push(...destructure[1].split(',').map(s => s.trim()).filter(Boolean));
    }
    const method = /require\([^)]+\)\.(\w+)/.exec(line);
    if (method) symbols.push(method[1]);
  } else if (type === 'import') {
    // import { a, b } from 'pkg' or import * as x from 'pkg' or import x from 'pkg'
    const named    = /import\s+\{([^}]+)\}/.exec(line);
    const namespace = /import\s+\*\s+as\s+(\w+)/.exec(line);
    const defaultI  = /import\s+(\w+)\s+from/.exec(line);
    if (named)     symbols.push(...named[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    if (namespace) symbols.push(`* as ${namespace[1]}`);
    if (defaultI && !named && !namespace) symbols.push(defaultI[1]);
  }
  return [...new Set(symbols)];
}

module.exports = { scanDirectory, parseImports, buildFingerprint };
