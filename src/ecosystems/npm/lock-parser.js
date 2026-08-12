'use strict';

const fs = require('fs');

/**
 * Parse a package-lock.json (lockfileVersion 2 or 3) into a dep map.
 *
 * Returns Map<packageName, Entry[]> where Entry = {
 *   resolvedVersion: string,
 *   dev: boolean,
 *   requires: { [pkgName]: rangeString },   // what this package requires
 *   parents: [{ name: string, range: string }], // packages that require this entry
 * }
 *
 * A package name may have multiple entries (different resolved versions in
 * nested node_modules for consumers that cannot share a version).
 */
function parseLockFile(lockFilePath) {
  const lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));

  if (!lock.packages) {
    throw new Error(
      `${lockFilePath} uses lockfileVersion ${lock.lockfileVersion || 1} (no flat packages map). ` +
      'Run npm install with npm v7+ to generate a v2/v3 lock file.'
    );
  }

  const depMap = new Map();

  // First pass: create an Entry for every non-root package
  for (const [pkgPath, pkgData] of Object.entries(lock.packages)) {
    if (pkgPath === '') continue;
    const name = pathToName(pkgPath);
    if (!name) continue;

    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push({
      resolvedVersion: pkgData.version || '',
      dev: pkgData.dev === true,
      requires: pkgData.dependencies || {},
      parents: [],
    });
  }

  // Second pass: for each package, register it as a parent of each dep it requires
  for (const [pkgPath, pkgData] of Object.entries(lock.packages)) {
    if (pkgPath === '') continue;
    const parentName = pathToName(pkgPath);
    if (!parentName) continue;

    const deps = pkgData.dependencies || {};
    for (const [depName, range] of Object.entries(deps)) {
      const depEntries = depMap.get(depName);
      if (!depEntries) continue;
      for (const entry of depEntries) {
        if (!entry.parents.find(p => p.name === parentName)) {
          entry.parents.push({ name: parentName, range });
        }
      }
    }
  }

  return depMap;
}

/**
 * Return the root package's direct dependencies and devDependencies from the lock file.
 * These are the packages the user can upgrade instead of adding overrides.
 */
function getRootDeps(lockFilePath) {
  const lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
  const root = (lock.packages || {})[''] || {};
  return {
    dependencies:    root.dependencies    || {},
    devDependencies: root.devDependencies || {},
  };
}

/**
 * Extract the package name from a node_modules path.
 * "node_modules/foo"                    → "foo"
 * "node_modules/@scope/pkg"             → "@scope/pkg"
 * "node_modules/foo/node_modules/bar"   → "bar"
 */
function pathToName(pkgPath) {
  const parts = pkgPath.split('node_modules/');
  if (parts.length < 2) return null;
  return parts[parts.length - 1].replace(/\/$/, '') || null;
}

/**
 * BFS from libraryName upward through the dep tree until a root dep is reached.
 * Returns the shortest path as package names, root-first:
 *   ["webpack", "enhanced-resolve", "fast-uri"]
 * Returns [] if no path found or the package isn't in the dep tree.
 *
 * @param {string} libraryName
 * @param {Map} depTree
 * @param {{ dependencies: object, devDependencies: object }} rootDeps
 */
function findDepChain(libraryName, depTree, rootDeps) {
  const allRootDeps = { ...rootDeps.dependencies, ...rootDeps.devDependencies };

  if (allRootDeps[libraryName]) return [libraryName];

  const entries = depTree.get(libraryName) || [];
  if (entries.length === 0) return [];

  const queue = [];
  const visited = new Set([libraryName]);

  // Seed: direct parents of the vulnerable package
  for (const entry of entries) {
    for (const parent of entry.parents) {
      if (!visited.has(parent.name)) {
        visited.add(parent.name);
        // path stored as [ancestor, ..., libraryName] — prepend ancestors as we go up
        queue.push({ name: parent.name, path: [parent.name, libraryName] });
      }
    }
  }

  while (queue.length > 0) {
    if (visited.size > 100) break; // guard against huge trees

    const { name, path } = queue.shift();

    if (allRootDeps[name]) {
      return path; // path is [rootDep, ..., libraryName]
    }

    const parentEntries = depTree.get(name) || [];
    for (const entry of parentEntries) {
      for (const parent of entry.parents) {
        if (!visited.has(parent.name)) {
          visited.add(parent.name);
          queue.push({ name: parent.name, path: [parent.name, ...path] });
        }
      }
    }
  }

  return [];
}

/**
 * Compute the blast radius of a package: how many packages (directly and transitively)
 * depend on it. Breaks down by production vs dev.
 *
 * @param {string} libraryName
 * @param {Map}    depTree  — from parseLockFile()
 * @returns {{
 *   directCount:     number,   // unique direct consumers
 *   transitiveCount: number,   // all ancestor packages (direct + indirect)
 *   productionCount: number,   // lock-file entries for this package with dev: false
 *   devCount:        number,   // lock-file entries for this package with dev: true
 *   consumers:       string[], // all ancestor package names (deduped)
 * }}
 */
function buildBlastRadius(libraryName, depTree) {
  const entries = depTree.get(libraryName) || [];

  const productionCount = entries.filter(e => !e.dev).length;
  const devCount        = entries.filter(e => e.dev).length;

  const directConsumers = new Set(entries.flatMap(e => e.parents.map(p => p.name)));

  // BFS upward through the reverse-dependency graph
  const allConsumers = new Set();
  const visited      = new Set([libraryName]);
  const queue        = [...directConsumers];

  for (const name of queue) {
    if (visited.has(name)) continue;
    visited.add(name);
    allConsumers.add(name);
    const parentEntries = depTree.get(name) || [];
    for (const entry of parentEntries) {
      for (const p of entry.parents) {
        if (!visited.has(p.name)) queue.push(p.name);
      }
    }
  }

  return {
    directCount:     directConsumers.size,
    transitiveCount: allConsumers.size,
    productionCount,
    devCount,
    consumers:       [...allConsumers],
  };
}

module.exports = { parseLockFile, getRootDeps, findDepChain, buildBlastRadius };
