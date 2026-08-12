'use strict';

const fs = require('fs');
const semver = require('semver');

/**
 * Parse an OWASP Dependency-Check JSON report into LibraryEntry[].
 *
 * Supports the Dependency-Check JSON schema (reportSchema "1.1"):
 *   { reportSchema: "1.1", dependencies: [ { packages, vulnerabilities, ... } ] }
 *
 * Package identity is extracted from the packages[].id field using the
 * purl (Package URL) format: "pkg:npm/name@version" or "pkg:maven/group:artifact@version".
 * Falls back to parsing fileName ("lodash-4.17.15.tgz") when no purl is present.
 *
 * Fix versions are derived from vulnerableSoftware[].software.versionEndExcluding.
 * CVSS v3 score is preferred over v2.
 */
function parseReport(filePath) {
  const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const deps = raw.dependencies || [];
  const byKey = new Map();

  for (const dep of deps) {
    if (!dep.vulnerabilities || !dep.vulnerabilities.length) continue;

    const { name, version, groupId, ecosystem } = extractPackageInfo(dep);
    if (!name || !version) continue;
    if (ecosystem && ecosystem !== 'npm' && ecosystem !== 'maven') continue;

    const isMaven      = ecosystem === 'maven';
    const dependencyFile = isMaven ? 'pom.xml' : inferDependencyFile(dep);
    const key = `${name}@${version}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey:     key,
        libraryName:    name,
        groupId:        groupId || null,
        libraryType:    isMaven ? 'MAVEN_ARTIFACT' : 'NODE_PACKAGED_MODULE',
        currentVersion: version,
        filename:       dep.fileName || (isMaven ? `${name}.jar` : `${name}-${version}.tgz`),
        dependencyFile,
        cves:           [],
      });
    }

    for (const vuln of dep.vulnerabilities) {
      const cveId = vuln.name || '';
      if (!cveId) continue;

      const severity    = normalizeSeverity(vuln);
      const score       = extractScore(vuln);
      const fixVersions = extractFixVersions(vuln);

      byKey.get(key).cves.push({ id: cveId, severity, score, fixVersions });
    }
  }

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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract package name, version, groupId, and ecosystem from an OWASP dependency entry.
 * Primary source: packages[].id purl; fallback: fileName.
 */
function extractPackageInfo(dep) {
  for (const pkg of (dep.packages || [])) {
    const parsed = parsePurl(pkg.id || '');
    if (parsed) return parsed;
  }

  // Fallback: "lodash-4.17.15.tgz" or "commons-lang3-3.12.0.jar"
  const fn = dep.fileName || '';
  const m  = fn.match(/^(.+?)-(\d+\.\d+[\d.]*)(?:\.tgz|\.jar|\.zip|\.war)?$/);
  if (m) {
    const version = semver.valid(semver.coerce(m[2])) || m[2];
    return { name: m[1], version, groupId: null, ecosystem: null };
  }

  return { name: null, version: null, groupId: null, ecosystem: null };
}

/**
 * Parse a Package URL (purl) string.
 * Formats:
 *   pkg:npm/lodash@4.17.15
 *   pkg:maven/org.apache.commons:commons-lang3@3.12.0
 */
function parsePurl(purl) {
  const m = purl.match(/^pkg:(npm|maven)\/([^@]+)@(.+)$/);
  if (!m) return null;

  const ecosystem = m[1];
  const fullName  = decodeURIComponent(m[2]);
  const rawVer    = m[3].split('?')[0]; // strip qualifiers
  const version   = semver.valid(semver.coerce(rawVer)) || rawVer;

  if (ecosystem === 'maven') {
    // fullName: "org.apache.commons:commons-lang3"
    const colon = fullName.lastIndexOf(':');
    const groupId = colon >= 0 ? fullName.slice(0, colon) : null;
    const name    = colon >= 0 ? fullName.slice(colon + 1) : fullName;
    return { name, version, groupId, ecosystem };
  }

  return { name: fullName, version, groupId: null, ecosystem };
}

function inferDependencyFile(dep) {
  const refs = dep.projectReferences || dep.includedBy || [];
  for (const ref of refs) {
    if (typeof ref === 'string' && ref) return ref;
    if (ref && ref.reference) return ref.reference;
  }
  return 'package.json';
}

function normalizeSeverity(vuln) {
  // OWASP uses severity field + severityLevels/cvssv3.baseSeverity
  const raw = (
    (vuln.cvssv3 && vuln.cvssv3.baseSeverity) ||
    vuln.severity ||
    ''
  ).toUpperCase();
  return raw || 'UNKNOWN';
}

function extractScore(vuln) {
  if (vuln.cvssv3 && vuln.cvssv3.baseScore != null) return parseFloat(vuln.cvssv3.baseScore);
  if (vuln.cvssv2 && vuln.cvssv2.score       != null) return parseFloat(vuln.cvssv2.score);
  return 0;
}

/**
 * Extract fix versions from vulnerableSoftware[].software entries.
 *
 * versionEndExcluding — the vulnerable range is (*, X); fix is X.
 * versionEndIncluding — the vulnerable range is (*, X]; fix is likely X+patch,
 *   but we include X as the candidate since we can't know the exact next release.
 */
function extractFixVersions(vuln) {
  const fixSet = new Set();
  for (const vs of (vuln.vulnerableSoftware || [])) {
    const sw = vs.software || {};
    if (sw.versionEndExcluding) {
      const v = semver.valid(semver.coerce(String(sw.versionEndExcluding)));
      if (v) fixSet.add(v);
    } else if (sw.versionEndIncluding) {
      const v = semver.valid(semver.coerce(String(sw.versionEndIncluding)));
      if (v) fixSet.add(v);
    }
  }
  return [...fixSet];
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like an OWASP Dependency-Check report.
 * Signature: { reportSchema: string, dependencies: array }
 */
function isOwaspFormat(data) {
  return (
    typeof data.reportSchema === 'string' &&
    Array.isArray(data.dependencies)
  );
}

module.exports = { parseReport, isOwaspFormat };
