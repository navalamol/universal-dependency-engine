'use strict';

const fs = require('fs');
const path = require('path');
const semver = require('semver');

/**
 * Parse an `npm audit --json` report into LibraryEntry[].
 *
 * Supports two npm audit output shapes:
 *   v2 (npm 7+): { auditReportVersion: 2, vulnerabilities: { [name]: { ... } } }
 *   v1 (npm 6):  { advisories: { [id]: { module_name, findings[], patched_versions, ... } } }
 *
 * Current installed version is looked up from package-lock.json in the same
 * directory as the audit report (or process.cwd() as fallback), since npm audit
 * v2 does not embed installed versions in its output.
 */
function parseReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (typeof raw.auditReportVersion === 'number' && raw.vulnerabilities) {
    return parseV2(raw, filePath);
  }
  if (raw.advisories && typeof raw.advisories === 'object') {
    return parseV1(raw);
  }
  return [];
}

// ---------------------------------------------------------------------------
// v2 parser (npm 7+)
// ---------------------------------------------------------------------------

function parseV2(raw, filePath) {
  const lockVersions = readLockVersions(filePath);
  const byKey = new Map();

  for (const [pkgName, vuln] of Object.entries(raw.vulnerabilities || {})) {
    const currentVersion =
      lockVersions.get(pkgName) ||
      deriveVersionFromExactRange(vuln.range);
    if (!currentVersion) continue;

    const fixVersions = extractFixVersionsV2(vuln);
    const cveEntries  = extractCveEntriesV2(vuln, pkgName, fixVersions);

    const key = `${pkgName}@${currentVersion}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey:     key,
        libraryName:    pkgName,
        groupId:        null,
        libraryType:    'NODE_PACKAGED_MODULE',
        currentVersion,
        filename:       `${pkgName}-${currentVersion}.tgz`,
        dependencyFile: 'package.json',
        cves:           [],
      });
    }
    byKey.get(key).cves.push(...cveEntries);
  }

  return dedupeAndReturn(byKey);
}

// ---------------------------------------------------------------------------
// v1 parser (npm 6)
// ---------------------------------------------------------------------------

function parseV1(raw) {
  const byKey = new Map();

  for (const advisory of Object.values(raw.advisories || {})) {
    const pkgName = advisory.module_name || '';
    if (!pkgName) continue;

    const fixVersions = parseFixFromRange(advisory.patched_versions);
    const cveIds = (advisory.cves || []).length ? advisory.cves : [`NPM-${advisory.id}`];
    const severity = (advisory.severity || '').toUpperCase() || 'UNKNOWN';
    const score    = parseFloat((advisory.cvss && advisory.cvss.score) || 0);

    for (const finding of (advisory.findings || [])) {
      const currentVersion = finding.version;
      if (!currentVersion || !semver.valid(currentVersion)) continue;

      const key = `${pkgName}@${currentVersion}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          libraryKey:     key,
          libraryName:    pkgName,
          groupId:        null,
          libraryType:    'NODE_PACKAGED_MODULE',
          currentVersion,
          filename:       `${pkgName}-${currentVersion}.tgz`,
          dependencyFile: 'package.json',
          cves:           [],
        });
      }
      for (const id of cveIds) {
        byKey.get(key).cves.push({ id, severity, score, fixVersions });
      }
    }
  }

  return dedupeAndReturn(byKey);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      // v2/v3 lockfile format
      for (const [key, val] of Object.entries(lock.packages || {})) {
        if (!key.startsWith('node_modules/') || !val.version) continue;
        const name = key.slice('node_modules/'.length);
        if (!versions.has(name)) versions.set(name, val.version);
      }
      // v1 lockfile format
      if (!versions.size) {
        for (const [name, val] of Object.entries(lock.dependencies || {})) {
          if (val.version && !versions.has(name)) versions.set(name, val.version);
        }
      }
      if (versions.size) return versions;
    } catch { /* try next candidate */ }
  }
  return new Map();
}

/**
 * If the range string IS an exact version (no operators), return it.
 * Avoids guessing versions from inequalities like "<4.17.21".
 */
function deriveVersionFromExactRange(range) {
  if (!range) return null;
  if (/[<>=^~*\s]/.test(range.trim())) return null;
  return semver.valid(semver.coerce(range.trim())) || null;
}

/** Extract the fix version from the npm audit v2 fixAvailable field. */
function extractFixVersionsV2(vuln) {
  if (vuln.fixAvailable && typeof vuln.fixAvailable === 'object' && vuln.fixAvailable.version) {
    const v = semver.valid(semver.coerce(String(vuln.fixAvailable.version)));
    if (v) return [v];
  }
  return [];
}

/**
 * Build CVE entries from the npm audit v2 via[] array.
 * via entries are either advisory objects or package-name strings (indirect refs).
 */
function extractCveEntriesV2(vuln, pkgName, fixVersions) {
  const entries = [];
  for (const via of (vuln.via || [])) {
    if (typeof via === 'string') continue; // indirect reference; skip
    const id       = advisoryId(via, pkgName);
    const severity = (via.severity || vuln.severity || '').toUpperCase() || 'UNKNOWN';
    const score    = parseFloat((via.cvss && via.cvss.score) || 0);
    entries.push({ id, severity, score, fixVersions });
  }
  // Fallback when via[] contains only string refs (all indirect)
  if (!entries.length) {
    const severity = (vuln.severity || '').toUpperCase() || 'UNKNOWN';
    entries.push({ id: `NPM-AUDIT-${pkgName}`, severity, score: 0, fixVersions });
  }
  return entries;
}

/** Derive a stable CVE/advisory identifier from an npm audit via object. */
function advisoryId(via, pkgName) {
  if (via.url) {
    const ghsa = via.url.match(/GHSA-[\w-]+/i);
    if (ghsa) return ghsa[0].toUpperCase();
    const npmId = via.url.match(/advisories\/(\d+)/);
    if (npmId) return `NPM-${npmId[1]}`;
  }
  if (via.source) return `NPM-${via.source}`;
  return `NPM-AUDIT-${pkgName}`;
}

/** Parse ">=4.17.21" or "^4.17.21" style patched_versions into [fixVersion]. */
function parseFixFromRange(patchedVersions) {
  if (!patchedVersions) return [];
  const m = patchedVersions.match(/>=?\s*([\d.]+)/);
  if (m) {
    const v = semver.valid(semver.coerce(m[1]));
    if (v) return [v];
  }
  return [];
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
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like an npm audit report.
 *   v2: { auditReportVersion: number }
 *   v1: { advisories: object, metadata: object }
 */
function isNpmAuditFormat(data) {
  if (typeof data.auditReportVersion === 'number') return true;
  return Boolean(
    data.advisories &&
    typeof data.advisories === 'object' &&
    !Array.isArray(data.advisories) &&
    data.metadata &&
    typeof data.metadata === 'object'
  );
}

module.exports = { parseReport, isNpmAuditFormat };
