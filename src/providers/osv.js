'use strict';

const fs = require('fs');
const path = require('path');
const semver = require('semver');

/**
 * Parse OSV-format vulnerability reports into LibraryEntry[].
 *
 * Supports two shapes:
 *
 *   1. osv-scanner JSON output (`osv-scanner --format json`):
 *      { results: [{ source: { path, type }, packages: [{ package, vulnerabilities[], groups[] }] }] }
 *      Installed version is embedded in package.version — no lock file needed.
 *
 *   2. OSV API bulk export (`{ vulns: [{ id, aliases, affected[], severity[] }] }`):
 *      Installed version is NOT present. Cross-references nearest package-lock.json.
 *      Entries whose version cannot be resolved are skipped.
 *
 * OSV ID precedence: prefer CVE-* alias over GHSA-* over raw OSV id.
 * Fix version: from SEMVER or ECOSYSTEM range event { fixed: "X.Y.Z" }.
 * Score: from database_specific.cvss3_score, database_specific.cvss, or severity vector (best-effort).
 */
function parseReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (Array.isArray(raw.results)) return parseOsvScanner(raw.results);
  if (Array.isArray(raw.vulns))   return parseOsvBulk(raw.vulns, filePath);
  return [];
}

// ---------------------------------------------------------------------------
// Shape 1: osv-scanner output
// ---------------------------------------------------------------------------

function parseOsvScanner(results) {
  const byKey = new Map();

  for (const result of results) {
    const depFile = result.source && result.source.path
      ? path.basename(result.source.path)
      : 'package.json';

    for (const pkgEntry of (result.packages || [])) {
      const pkg = pkgEntry.package || {};
      const name    = pkg.name || '';
      const version = pkg.version || '';
      if (!name || !version || !semver.valid(version)) continue;

      const ecosystem = (pkg.ecosystem || '').toLowerCase();
      if (ecosystem && !isSupportedEcosystem(ecosystem)) continue;

      const key = `${name}@${version}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          libraryKey:     key,
          libraryName:    name,
          groupId:        extractMavenGroupId(name, ecosystem),
          libraryType:    ecosystemToLibraryType(ecosystem),
          currentVersion: version,
          filename:       inferFilename(name, version, ecosystem),
          dependencyFile: inferDependencyFile(depFile, ecosystem),
          cves:           [],
        });
      }

      for (const vuln of (pkgEntry.vulnerabilities || [])) {
        const cveEntry = buildCveEntry(vuln, name, ecosystem);
        byKey.get(key).cves.push(cveEntry);
      }
    }
  }

  return dedupeAndReturn(byKey);
}

// ---------------------------------------------------------------------------
// Shape 2: OSV API bulk export
// ---------------------------------------------------------------------------

function parseOsvBulk(vulns, filePath) {
  const lockVersions = readLockVersions(filePath);
  const byKey = new Map();

  for (const vuln of vulns) {
    for (const affected of (vuln.affected || [])) {
      const pkg = affected.package || {};
      const name = pkg.name || '';
      if (!name) continue;
      const ecosystem = (pkg.ecosystem || '').toLowerCase();
      if (ecosystem && !isSupportedEcosystem(ecosystem)) continue;

      const version = lockVersions.get(name) || resolveFromVersionsList(affected.versions);
      if (!version) continue;

      const key = `${name}@${version}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          libraryKey:     key,
          libraryName:    name,
          groupId:        extractMavenGroupId(name, ecosystem),
          libraryType:    ecosystemToLibraryType(ecosystem),
          currentVersion: version,
          filename:       inferFilename(name, version, ecosystem),
          dependencyFile: ecosystem === 'maven' ? 'pom.xml' : 'package.json',
          cves:           [],
        });
      }

      byKey.get(key).cves.push(buildCveEntry(vuln, name, ecosystem));
    }
  }

  return dedupeAndReturn(byKey);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildCveEntry(vuln, pkgName, ecosystem) {
  const id          = preferredId(vuln);
  const fixVersions = extractFixVersions(vuln, pkgName, ecosystem);
  const { severity, score } = extractSeverity(vuln);
  return { id, severity, score, fixVersions };
}

/** Prefer CVE-* alias, then GHSA-*, then raw OSV id. */
function preferredId(vuln) {
  const aliases = (vuln.aliases || []).concat(vuln.id || []);
  const cve  = aliases.find(a => /^CVE-/i.test(a));
  if (cve) return cve.toUpperCase();
  const ghsa = aliases.find(a => /^GHSA-/i.test(a));
  if (ghsa) return ghsa.toUpperCase();
  return vuln.id || 'OSV-UNKNOWN';
}

/**
 * Extract fix versions from OSV affected[].ranges[].events.
 * Looks at both SEMVER and ECOSYSTEM range types.
 */
function extractFixVersions(vuln, pkgName, ecosystem) {
  const fixSet = new Set();
  for (const affected of (vuln.affected || [])) {
    const apkg = affected.package || {};
    // Only extract from the matching package+ecosystem
    if (apkg.name && apkg.name.toLowerCase() !== pkgName.toLowerCase()) continue;

    for (const range of (affected.ranges || [])) {
      if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
      for (const event of (range.events || [])) {
        if (event.fixed) {
          const v = semver.valid(semver.coerce(String(event.fixed)));
          if (v) fixSet.add(v);
        }
      }
    }
  }
  return [...fixSet];
}

/**
 * Extract severity text and numeric score from OSV vuln.
 * OSV has multiple possible locations depending on the upstream database:
 *   - database_specific.cvss3_score (NVD, PyPI)
 *   - database_specific.cvss.score  (GitHub)
 *   - severity[].score              (CVSS vector — score not parseable without calculator)
 *   - database_specific.severity    (plain text like "HIGH")
 */
function extractSeverity(vuln) {
  // Numeric score — check known locations
  const ds = vuln.database_specific || {};
  let score = 0;
  if (typeof ds.cvss3_score === 'number') score = ds.cvss3_score;
  else if (ds.cvss && typeof ds.cvss.score === 'number') score = ds.cvss.score;
  else if (ds.cvss && typeof ds.cvss === 'number') score = ds.cvss;

  // Severity text — prefer database_specific, then derive from score
  let severity = (ds.severity || '').toUpperCase();
  if (!severity && score >= 9.0)  severity = 'CRITICAL';
  else if (!severity && score >= 7.0) severity = 'HIGH';
  else if (!severity && score >= 4.0) severity = 'MEDIUM';
  else if (!severity && score > 0)    severity = 'LOW';
  else if (!severity)                 severity = 'UNKNOWN';

  return { severity, score };
}

/** Pick the most recent version from a versions list as best-effort installed guess. */
function resolveFromVersionsList(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  const valid = versions.map(v => semver.valid(semver.coerce(String(v)))).filter(Boolean);
  if (!valid.length) return null;
  valid.sort(semver.compare);
  // Return the latest non-patched version (not necessarily correct, but better than nothing)
  return valid[valid.length - 1];
}

function isSupportedEcosystem(eco) {
  // Accept npm-adjacent and maven; pass through unknown (eco may be empty)
  return ['npm', 'maven', 'node', 'yarn', 'pnpm', ''].includes(eco) ||
    eco.includes('npm') || eco.includes('maven');
}

function ecosystemToLibraryType(eco) {
  if (eco === 'maven' || eco.includes('maven')) return 'MAVEN_ARTIFACT';
  return 'NODE_PACKAGED_MODULE';
}

function extractMavenGroupId(name, ecosystem) {
  if (ecosystem !== 'maven') return null;
  // Maven names in OSV are usually "group:artifact"
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(0, colon) : null;
}

function inferFilename(name, version, ecosystem) {
  if (ecosystem === 'maven') return `${name}-${version}.jar`;
  return `${name}-${version}.tgz`;
}

function inferDependencyFile(sourceFile, ecosystem) {
  if (ecosystem === 'maven') return 'pom.xml';
  if (sourceFile && sourceFile !== '.') return sourceFile;
  return 'package.json';
}

/** Read package name → installed version from nearest package-lock.json. */
function readLockVersions(reportFilePath) {
  const dir = path.dirname(path.resolve(reportFilePath));
  const candidates = [
    path.join(dir, 'package-lock.json'),
    path.join(process.cwd(), 'package-lock.json'),
  ];
  for (const lp of candidates) {
    if (!fs.existsSync(lp)) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(lp, 'utf8'));
      const versions = new Map();
      for (const [key, val] of Object.entries(lock.packages || {})) {
        if (!key.startsWith('node_modules/') || !val.version) continue;
        const name = key.slice('node_modules/'.length);
        if (!versions.has(name)) versions.set(name, val.version);
      }
      if (!versions.size) {
        for (const [name, val] of Object.entries(lock.dependencies || {})) {
          if (val.version && !versions.has(name)) versions.set(name, val.version);
        }
      }
      if (versions.size) return versions;
    } catch { /* try next */ }
  }
  return new Map();
}

function dedupeAndReturn(byKey) {
  for (const entry of byKey.values()) {
    const seen = new Set();
    entry.cves = entry.cves.filter(c => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }
  return [...byKey.values()].filter(e => e.cves.length > 0);
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like an OSV-format report.
 *   osv-scanner: { results: [{ source, packages }] }
 *   OSV API bulk: { vulns: [{ id, affected }] }
 */
function isOsvFormat(data) {
  // osv-scanner output
  if (Array.isArray(data.results) && data.results.length > 0) {
    const r = data.results[0];
    return Boolean(r.source && Array.isArray(r.packages));
  }
  // OSV API bulk output
  if (Array.isArray(data.vulns)) {
    if (data.vulns.length === 0) return false;
    const sample = data.vulns[0];
    return Boolean(sample.id && Array.isArray(sample.affected));
  }
  return false;
}

module.exports = { parseReport, isOsvFormat };
