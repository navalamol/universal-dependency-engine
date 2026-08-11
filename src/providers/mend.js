'use strict';

const fs = require('fs');
const path = require('path');
const semver = require('semver');

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a Mend fixResolution string and extract all semver versions that apply
 * to the given package name.
 *
 * Handles formats:
 *   "packageName - X.Y.Z"
 *   "https://github.com/.../packageName.git - vX.Y.Z"
 *   "https://github.com/.../repo.git - packageName@X.Y.Z"
 *   "groupId:artifactId:version"  (Maven GAV coordinate)
 */
function parseFixVersions(packageName, fixResolution) {
  if (!fixResolution) return [];

  const cleaned = fixResolution.replace(/^Upgrade to version\s*/i, '');
  const result = new Set();

  for (const raw of cleaned.split(',')) {
    const seg = raw.trim();
    if (!seg) continue;

    // Skip segments that don't reference this package
    if (!seg.toLowerCase().includes(packageName.toLowerCase())) continue;

    // Pattern 1: "packageName@X.Y.Z" (monorepo git URL format)
    const atMatch = seg.match(new RegExp(escapeRe(packageName) + '@v?(\\d+\\.\\d+[\\d.]*)', 'i'));
    if (atMatch) {
      const v = semver.valid(semver.coerce(atMatch[1]));
      if (v) { result.add(v); continue; }
    }

    // Pattern 2: Maven GAV "groupId:artifactId:version" — matches "artifactId:version" within the segment
    const gavMatch = seg.match(new RegExp(escapeRe(packageName) + ':v?(\\d+\\.\\d+[\\d.]*)', 'i'));
    if (gavMatch) {
      const v = semver.valid(semver.coerce(gavMatch[1]));
      if (v) { result.add(v); continue; }
    }

    // Pattern 3: "xxx - vX.Y.Z" or "xxx - X.Y.Z" at end of segment
    const dashMatch = seg.match(/\s+-\s+v?(\d+\.\d+[\d.]*\d)\s*$/);
    if (dashMatch) {
      const v = semver.valid(semver.coerce(dashMatch[1]));
      if (v) result.add(v);
    }
  }

  return [...result];
}

/**
 * Parse Mend JSON report.
 * Groups vulnerabilities by library.keyUuid so multiple CVEs per library are merged.
 *
 * Returns: LibraryEntry[]
 *   { libraryKey, libraryName, currentVersion, filename, dependencyFile, cves[] }
 */
function parseJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const vulns = Array.isArray(raw) ? raw : (raw.vulnerabilities || []);

  const byKey = new Map();

  for (const v of vulns) {
    const lib = v.library || {};
    const key = lib.keyUuid || `${lib.name}@${lib.version}`;
    const isMaven = lib.type === 'MAVEN_ARTIFACT';

    if (!byKey.has(key)) {
      const rawVersion = lib.version || '';
      const currentVersion = isMaven
        ? (semver.valid(rawVersion) || semver.valid(semver.coerce(rawVersion)) || rawVersion)
        : rawVersion;

      byKey.set(key, {
        libraryKey: key,
        libraryName: isMaven ? (lib.artifactId || lib.name || '') : (lib.name || ''),
        groupId: lib.groupId || null,
        libraryType: lib.type || 'NODE_PACKAGED_MODULE',
        currentVersion,
        filename: lib.filename || '',
        dependencyFile: (v.locations || [])[0]?.dependencyFile || '',
        cves: [],
      });
    }

    const entry = byKey.get(key);
    const nameForParsing = isMaven ? (lib.artifactId || lib.name) : lib.name;

    // Collect all fix versions from topFix + allFixes
    const fixSources = [v.topFix, ...(v.allFixes || [])].filter(Boolean);
    const fixVersions = new Set();
    for (const fix of fixSources) {
      for (const fv of parseFixVersions(nameForParsing, fix.fixResolution || '')) {
        fixVersions.add(fv);
      }
    }

    entry.cves.push({
      id: v.name || '',
      severity: (v.cvss3_severity || v.severity || '').toUpperCase(),
      score: parseFloat(v.cvss3_score || v.score || 0),
      fixVersions: [...fixVersions],
    });
  }

  return [...byKey.values()];
}

/**
 * Parse Mend Excel report.
 * Attempts to detect column names automatically.
 */
function parseExcel(filePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (rows.length === 0) return [];

  const cols = Object.keys(rows[0]);
  const find = (...patterns) =>
    cols.find(c => patterns.some(p => c.toLowerCase().includes(p.toLowerCase())));

  const colLibName = find('library name', 'lib name', 'component', 'package name', 'artifact');
  const colLibVer  = find('library version', 'version', 'lib ver', 'artifact version');
  const colCve     = find('cve', 'vulnerability id', 'vuln id', 'advisory');
  const colSev     = find('severity');
  const colScore   = find('cvss3 score', 'cvss score', 'score');
  const colFix     = find('fix resolution', 'resolution', 'recommended fix', 'fix');

  const byKey = new Map();

  for (const row of rows) {
    const name    = String(row[colLibName] || '').trim();
    const version = String(row[colLibVer]  || '').trim();
    const cveId   = String(row[colCve]     || '').trim();
    const severity= String(row[colSev]     || '').toUpperCase().trim();
    const score   = parseFloat(row[colScore]) || 0;
    const fixRes  = String(row[colFix]     || '').trim();

    if (!name || !version) continue;

    const key = `${name}@${version}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey: key,
        libraryName: name,
        currentVersion: version,
        filename: `${name}-${version}.tgz`,
        dependencyFile: '',
        cves: [],
      });
    }

    if (cveId) {
      byKey.get(key).cves.push({
        id: cveId,
        severity,
        score,
        fixVersions: parseFixVersions(name, fixRes),
      });
    }
  }

  return [...byKey.values()];
}

/**
 * Parse a Mend vulnerability report (JSON or Excel).
 */
function parseReport(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return parseJson(filePath);
  if (ext === '.xlsx' || ext === '.xls') return parseExcel(filePath);
  throw new Error(`Unsupported report format: ${ext}. Use .json or .xlsx`);
}

module.exports = { parseReport, parseFixVersions };
