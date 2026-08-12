'use strict';

const fs = require('fs');
const path = require('path');
const semver = require('semver');

/**
 * Parse a GitHub Dependabot alerts export into LibraryEntry[].
 *
 * Input: JSON array exported from the GitHub Security API:
 *   GET /repos/{owner}/{repo}/dependabot/alerts
 *   or `gh api /repos/{owner}/{repo}/dependabot/alerts --paginate`
 *
 * Each alert:
 *   {
 *     number: 1,
 *     state: "open",
 *     dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package.json" },
 *     security_advisory: { ghsa_id, cve_id, severity, cvss: { score }, ... },
 *     security_vulnerability: { vulnerable_version_range, first_patched_version: { identifier } }
 *   }
 *
 * Dependabot does not embed installed versions — they are looked up from the
 * nearest package-lock.json relative to the alerts file (or process.cwd()).
 * Alerts for packages that cannot be resolved to an installed version are skipped.
 *
 * Only open alerts and npm-ecosystem packages are processed; Maven alerts are
 * also accepted (detected by ecosystem === "maven").
 */
function parseReport(filePath) {
  const raw   = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const alerts = Array.isArray(raw) ? raw : (raw.alerts || []);

  const lockVersions = readLockVersions(filePath);
  const byKey = new Map();

  for (const alert of alerts) {
    if (alert.state && alert.state !== 'open') continue;

    const dep = alert.dependency || {};
    const pkg = dep.package    || {};
    const ecosystem = (pkg.ecosystem || '').toLowerCase();
    if (ecosystem && ecosystem !== 'npm' && ecosystem !== 'maven') continue;

    const pkgName = pkg.name || '';
    if (!pkgName) continue;

    const sv = alert.security_vulnerability || {};
    const sa = alert.security_advisory      || {};

    const currentVersion =
      lockVersions.get(pkgName) ||
      deriveVersionFromRange(sv.vulnerable_version_range);
    if (!currentVersion) continue;

    const fixVersion = extractFixVersion(sv.first_patched_version);
    const fixVersions = fixVersion ? [fixVersion] : [];

    const cveId   = sa.cve_id || sa.ghsa_id || `DEPENDABOT-${alert.number || pkgName}`;
    const severity = (sv.severity || sa.severity || '').toUpperCase() || 'UNKNOWN';
    const score    = parseFloat((sa.cvss && sa.cvss.score) || 0);

    const isMaven   = ecosystem === 'maven';
    const key       = `${pkgName}@${currentVersion}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey:     key,
        libraryName:    pkgName,
        groupId:        null,
        libraryType:    isMaven ? 'MAVEN_ARTIFACT' : 'NODE_PACKAGED_MODULE',
        currentVersion,
        filename:       isMaven ? `${pkgName}.jar` : `${pkgName}-${currentVersion}.tgz`,
        dependencyFile: dep.manifest_path || (isMaven ? 'pom.xml' : 'package.json'),
        cves:           [],
      });
    }
    byKey.get(key).cves.push({ id: cveId, severity, score, fixVersions });
  }

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
    } catch { /* try next candidate */ }
  }
  return new Map();
}

function extractFixVersion(firstPatchedVersion) {
  const id = firstPatchedVersion && firstPatchedVersion.identifier;
  if (!id) return null;
  return semver.valid(semver.coerce(String(id))) || null;
}

/**
 * If the vulnerable_version_range is an exact version (no operators), use it.
 * e.g., "= 4.17.15" → "4.17.15"; "< 4.17.21" → null (we can't know what's installed).
 */
function deriveVersionFromRange(range) {
  if (!range) return null;
  const eqMatch = range.match(/^=\s*([\d.]+)/);
  if (eqMatch) return semver.valid(semver.coerce(eqMatch[1])) || null;
  return null;
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like a Dependabot alerts array.
 * Signature: array of objects each carrying security_advisory + dependency.
 */
function isDependabotFormat(data) {
  if (!Array.isArray(data) || !data.length) return false;
  const sample = data[0];
  return Boolean(
    sample.security_advisory &&
    typeof sample.security_advisory === 'object' &&
    sample.dependency &&
    typeof sample.dependency === 'object'
  );
}

module.exports = { parseReport, isDependabotFormat };
