'use strict';

const fs = require('fs');
const semver = require('semver');

/**
 * Parse a JFrog Xray JSON vulnerability report into LibraryEntry[].
 *
 * Input: Xray REST API export or Artifactory scan result.
 *   `POST /api/v1/summary/artifact` or `GET /api/v1/violations`
 *
 * Shape:
 *   {
 *     total_count: 2,
 *     data: [
 *       {
 *         severity: "High",
 *         summary: "Command Injection in lodash",
 *         issue_id: "XRAY-123456",
 *         cves: [
 *           { cve: "CVE-2021-23337", cvss_v3_score: "7.2", cvss_v3_vector: "CVSS:3.1/..." }
 *         ],
 *         components: [
 *           {
 *             component_id: "npm://lodash:4.17.15",
 *             package_type: "npm",
 *             fixed_versions: ["4.17.21"],
 *             infected_versions: ["[0.0.0,4.17.21)"]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Component ID formats:
 *   npm://name:version                       → npm
 *   npm://name:version::                     → npm (some exports include trailing colons)
 *   gav://groupId:artifactId:version         → Maven
 *   pypi://name:version                      → Python
 *   go://module@version                      → Go
 *
 * Fix versions: taken directly from components[].fixed_versions[] (no parsing needed).
 * Installed version: embedded in component_id after the last colon (npm/pypi) or @version (go).
 */
function parseReport(filePath) {
  const raw     = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const issues  = Array.isArray(raw.data) ? raw.data : [];
  const byKey   = new Map();

  for (const issue of issues) {
    const severity = normalizeSeverity(issue.severity);
    const cveData  = extractCveData(issue);

    for (const comp of (issue.components || [])) {
      const parsed = parseComponentId(comp.component_id || '');
      if (!parsed) continue;

      const { name, version, ecosystem, groupId } = parsed;
      if (!isSupportedEcosystem(ecosystem)) continue;

      const isMaven  = ecosystem === 'maven';
      const fixVersions = extractFixVersions(comp.fixed_versions || []);

      const key = `${name}@${version}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          libraryKey:     key,
          libraryName:    name,
          groupId:        groupId || null,
          libraryType:    isMaven ? 'MAVEN_ARTIFACT' : 'NODE_PACKAGED_MODULE',
          currentVersion: version,
          filename:       `${name}-${version}${isMaven ? '.jar' : '.tgz'}`,
          dependencyFile: isMaven ? 'pom.xml' : 'package.json',
          cves:           [],
        });
      }

      for (const { id, score } of cveData) {
        byKey.get(key).cves.push({ id, severity, score, fixVersions });
      }

      // If no CVEs, emit one entry using the Xray issue_id so the engine can still classify
      if (!cveData.length) {
        const xrayId = issue.issue_id || `XRAY-${name}`;
        byKey.get(key).cves.push({ id: xrayId, severity, score: 0, fixVersions });
      }
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
// Component ID parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JFrog Xray component_id string into { name, version, ecosystem, groupId }.
 *
 * Known formats:
 *   npm://lodash:4.17.15
 *   npm://lodash:4.17.15::
 *   gav://org.apache.commons:commons-lang3:3.9.0
 *   pypi://requests:2.28.0
 *   go://golang.org/x/net:0.10.0
 *   go://golang.org/x/net@v0.10.0
 */
function parseComponentId(compId) {
  if (!compId) return null;

  const colonSlash = compId.indexOf('://');
  if (colonSlash < 0) return null;

  const scheme = compId.slice(0, colonSlash).toLowerCase();
  const rest   = compId.slice(colonSlash + 3).replace(/::+$/, ''); // strip trailing colons

  if (scheme === 'npm' || scheme === 'pypi') {
    // "name:version"
    const lastColon = rest.lastIndexOf(':');
    if (lastColon < 0) return null;
    const name    = rest.slice(0, lastColon);
    const rawVer  = rest.slice(lastColon + 1);
    const version = semver.valid(rawVer) || semver.valid(semver.coerce(rawVer));
    if (!version || !name) return null;
    return { name, version, ecosystem: scheme === 'pypi' ? 'python' : 'npm', groupId: null };
  }

  if (scheme === 'gav') {
    // "groupId:artifactId:version"
    const parts = rest.split(':');
    if (parts.length < 3) return null;
    const groupId  = parts[0];
    const name     = parts[1];
    const rawVer   = parts[2];
    const version  = semver.valid(rawVer) || semver.valid(semver.coerce(rawVer)) || rawVer;
    if (!name || !version) return null;
    return { name, version, ecosystem: 'maven', groupId };
  }

  if (scheme === 'go') {
    // "module@version" or "module:version"
    const atIdx    = rest.indexOf('@');
    const colonIdx = rest.lastIndexOf(':');
    const sepIdx   = atIdx >= 0 ? atIdx : colonIdx;
    if (sepIdx < 0) return null;
    const name     = rest.slice(0, sepIdx);
    const rawVer   = rest.slice(sepIdx + 1).replace(/^v/, '');
    const version  = semver.valid(rawVer) || semver.valid(semver.coerce(rawVer));
    if (!version || !name) return null;
    return { name, version, ecosystem: 'go', groupId: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCveData(issue) {
  return (issue.cves || []).map(c => ({
    id:    (c.cve || '').toUpperCase() || `XRAY-${issue.issue_id || 'UNKNOWN'}`,
    score: parseFloat(c.cvss_v3_score || c.cvss_v2_score || 0),
  })).filter(c => c.id);
}

function extractFixVersions(fixedVersions) {
  return fixedVersions
    .map(v => {
      const clean = String(v).replace(/[[\]()]/g, '').trim();
      return semver.valid(clean) || semver.valid(semver.coerce(clean));
    })
    .filter(Boolean);
}

function normalizeSeverity(raw) {
  const map = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'LOW', unknown: 'UNKNOWN' };
  return map[(raw || '').toLowerCase()] || 'UNKNOWN';
}

/** Only auto-apply for npm and maven; pass through but do not filter go/python. */
function isSupportedEcosystem(eco) {
  return ['npm', 'maven', 'python', 'go'].includes(eco);
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like a JFrog Xray report.
 * Signature: { data: [{ components: [{ component_id }] }] }
 *   or       { total_count: number, data: [...] }
 */
function isXrayFormat(data) {
  if (!Array.isArray(data.data) || !data.data.length) return false;
  const sample = data.data[0];
  return Boolean(
    Array.isArray(sample.components) &&
    sample.components.length > 0 &&
    typeof sample.components[0].component_id === 'string'
  );
}

module.exports = { parseReport, isXrayFormat };
