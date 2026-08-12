'use strict';

const fs = require('fs');
const semver = require('semver');

/**
 * Parse a Snyk JSON vulnerability report into LibraryEntry[].
 *
 * Supports three Snyk output shapes:
 *   1. `snyk test --json`            → { vulnerabilities[], packageManager, ... }
 *   2. `snyk test --json --all-projects` → { projects: [{ vulnerabilities[] }] }
 *   3. Flat array                    → vulnerability[]
 *
 * Each vulnerability entry in the Snyk format:
 *   {
 *     id: "SNYK-JS-PKG-12345",
 *     cves: ["CVE-2021-12345"],       // may be absent
 *     severity: "high",
 *     cvssScore: 7.4,                // or cvss.score
 *     packageName: "lodash",
 *     version: "4.17.15",
 *     fixedIn: ["4.17.21"],
 *     from: ["root@1.0.0", "lodash@4.17.15"],
 *   }
 */
function parseReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const vulns = collectVulnerabilities(raw);
  const byKey = new Map();

  for (const v of vulns) {
    const name    = (v.packageName || v.moduleName || '').trim();
    const version = (v.version || '').trim();
    if (!name || !version) continue;

    const key = `${name}@${version}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey:     key,
        libraryName:    name,
        groupId:        null,
        libraryType:    'NODE_PACKAGED_MODULE',
        currentVersion: version,
        filename:       `${name}-${version}.tgz`,
        dependencyFile: inferDependencyFile(v),
        cves:           [],
      });
    }

    byKey.get(key).cves.push(buildCveEntry(v));
  }

  // Deduplicate CVE ids within each library entry
  for (const entry of byKey.values()) {
    const seen = new Set();
    entry.cves = entry.cves.filter(c => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten any of the three Snyk output shapes into a flat vulnerabilities[].
 */
function collectVulnerabilities(raw) {
  // Shape 3: flat array
  if (Array.isArray(raw)) {
    return raw.filter(v => v.packageName || v.moduleName);
  }

  // Shape 2: { projects: [{ vulnerabilities[] }] }
  if (Array.isArray(raw.projects)) {
    return raw.projects.flatMap(p => p.vulnerabilities || []);
  }

  // Shape 1: { vulnerabilities[] }
  return raw.vulnerabilities || [];
}

/**
 * Build a CVE entry from a Snyk vulnerability object.
 * Snyk uses advisory IDs like SNYK-JS-PKG-12345; the cves[] array holds
 * mapped CVE IDs when available.  We prefer real CVE IDs but fall back to
 * the Snyk advisory ID so the entry is never blank.
 */
function buildCveEntry(v) {
  const cveIds = Array.isArray(v.cves) && v.cves.length ? v.cves : null;
  const id = cveIds ? cveIds[0] : (v.id || '');

  const severity = (v.severity || '').toUpperCase() || 'UNKNOWN';
  const score    = parseFloat(v.cvssScore || (v.cvss && v.cvss.score) || 0);

  const fixVersions = (v.fixedIn || [])
    .map(fv => semver.valid(semver.coerce(String(fv))))
    .filter(Boolean);

  return { id, severity, score, fixVersions };
}

/**
 * Best-effort: infer the dependency file from the `from` chain or packageManager.
 */
function inferDependencyFile(v) {
  if (v.packageManager === 'maven') return 'pom.xml';
  return 'package.json';
}

// ---------------------------------------------------------------------------
// Format detection helper (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like a Snyk report.
 * Snyk reports have either:
 *   - root-level `packageManager` field, or
 *   - vulnerabilities whose entries carry `packageName` + `fixedIn`
 */
function isSnykFormat(data) {
  if (typeof data.packageManager === 'string') return true;

  const vulns = Array.isArray(data.projects)
    ? (data.projects[0]?.vulnerabilities || [])
    : (data.vulnerabilities || (Array.isArray(data) ? data : []));

  const sample = vulns[0];
  return Boolean(sample && (sample.packageName || sample.moduleName) && sample.fixedIn);
}

module.exports = { parseReport, isSnykFormat };
