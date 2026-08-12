'use strict';

const fs = require('fs');
const semver = require('semver');

// ---------------------------------------------------------------------------
// GitLab API write-back (MR creation + comments)
// ---------------------------------------------------------------------------

const GITLAB_API_VERSION = 'v4';
const TIMEOUT_MS = 15000;

function gitlabHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'mendfix-gitlab-writeback',
  };
}

async function gitlabRequest(method, baseUrl, path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const opts = {
      method,
      headers: gitlabHeaders(token),
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}/api/${GITLAB_API_VERSION}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a GitLab merge request.
 * projectId: numeric id or URL-encoded namespace/path (e.g. "mygroup%2Fmyrepo")
 * opts: { title, description?, sourceBranch, targetBranch?, removeSourceBranch? }
 * baseUrl: defaults to https://gitlab.com — override for self-hosted instances
 * Returns { ok, status, data: { iid, web_url } }
 */
async function createMR(projectId, token, opts, baseUrl = 'https://gitlab.com') {
  const {
    title,
    description = '',
    sourceBranch,
    targetBranch = 'main',
    removeSourceBranch = true,
  } = opts;
  const encodedId = encodeURIComponent(String(projectId));
  return gitlabRequest('POST', baseUrl, `/projects/${encodedId}/merge_requests`, token, {
    title,
    description,
    source_branch: sourceBranch,
    target_branch: targetBranch,
    remove_source_branch: removeSourceBranch,
  });
}

/**
 * Post a note (comment) on an existing merge request.
 * mrIid: the MR's internal project IID (not the global ID).
 * Returns { ok, status, data }
 */
async function addMRComment(projectId, mrIid, token, body, baseUrl = 'https://gitlab.com') {
  const encodedId = encodeURIComponent(String(projectId));
  return gitlabRequest('POST', baseUrl, `/projects/${encodedId}/merge_requests/${mrIid}/notes`, token, { body });
}

/**
 * Parse a GitLab Dependency Scanning JSON report into LibraryEntry[].
 *
 * Input: GitLab CI artifact from the `gemnasium` or `dependency_scanning` job.
 *   `gl-dependency-scanning-report.json` — GitLab Security Report format v15+
 *
 * Shape:
 *   {
 *     version: "15.0.4",
 *     vulnerabilities: [
 *       {
 *         id: "uuid",
 *         severity: "High",
 *         cve: "CVE-2021-23337",         // legacy top-level cve field
 *         location: {
 *           file: "package.json",
 *           dependency: { package: { name: "lodash" }, version: "4.17.15" }
 *         },
 *         identifiers: [{ type: "cve", value: "CVE-2021-23337" }, ...],
 *         solution: "Upgrade lodash to version 4.17.21 or above.",
 *         cvss_v3: { base_score: 7.2 }   // present on newer reports
 *       }
 *     ],
 *     remediations: [                     // top-level remediation map (newer format)
 *       { fixes: [{ id: "vuln-uuid" }], summary: "Upgrade lodash from 4.17.15 to 4.17.21" }
 *     ]
 *   }
 *
 * Fix version sources (tried in order):
 *   1. remediations[].summary "from X to Y" parse
 *   2. solution field "version X.Y.Z" parse
 *   3. identifiers[] type "remediation" or "fixed_version"
 */
function parseReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const vulns        = raw.vulnerabilities || [];
  const remediations = buildRemediationMap(raw.remediations || []);
  const byKey        = new Map();

  for (const vuln of vulns) {
    const loc = vuln.location || {};
    const dep = loc.dependency || {};
    const pkg = dep.package || {};

    const name    = pkg.name || vuln.packageName || '';
    const version = dep.version || vuln.packageVersion || '';
    if (!name || !version) continue;

    const ecosystem = inferEcosystem(loc.file || '');

    const resolvedVersion = semver.valid(version) ||
      semver.valid(semver.coerce(version)) ||
      null;
    if (!resolvedVersion) continue;

    const cveId      = extractCveId(vuln);
    const severity   = normalizeSeverity(vuln.severity);
    const score      = extractScore(vuln);
    const fixVersions = extractFixVersions(vuln, remediations);

    const libraryType = ecosystemToLibraryType(ecosystem);
    const key         = `${name}@${resolvedVersion}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        libraryKey:     key,
        libraryName:    name,
        groupId:        null,
        libraryType,
        currentVersion: resolvedVersion,
        filename:       loc.file || inferFilename(name, resolvedVersion, ecosystem),
        dependencyFile: loc.file || inferDependencyFile(ecosystem),
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

  return [...byKey.values()].filter(e => e.cves.length > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of vulnerability-uuid → fixVersion from the top-level
 * remediations array ("Upgrade lodash from 4.17.15 to 4.17.21").
 */
function buildRemediationMap(remediations) {
  const map = new Map(); // vuln id → fixVersion string
  for (const r of remediations) {
    const fixVer = extractVersionFromSummary(r.summary || '');
    if (!fixVer) continue;
    for (const fix of (r.fixes || [])) {
      if (fix.id) map.set(fix.id, fixVer);
    }
  }
  return map;
}

function extractVersionFromSummary(summary) {
  // "Upgrade X from 4.17.15 to 4.17.21" → 4.17.21
  const toMatch = summary.match(/\bto\s+([\d.]+)/i);
  if (toMatch) return semver.valid(semver.coerce(toMatch[1])) || null;
  return null;
}

function extractFixVersions(vuln, remediationMap) {
  const fixSet = new Set();

  // 1. Top-level remediation map
  const fromMap = remediationMap.get(vuln.id);
  if (fromMap) fixSet.add(fromMap);

  // 2. solution field: "Upgrade X to version Y or above."
  const solution = vuln.solution || '';
  const solMatch = solution.match(/version\s+([\d.]+)/i);
  if (solMatch) {
    const v = semver.valid(semver.coerce(solMatch[1]));
    if (v) fixSet.add(v);
  }

  // 3. identifiers of type "remediation" or "fixed_version"
  for (const id of (vuln.identifiers || [])) {
    if (['remediation', 'fixed_version', 'patch'].includes((id.type || '').toLowerCase())) {
      const v = semver.valid(semver.coerce(String(id.value)));
      if (v) fixSet.add(v);
    }
  }

  return [...fixSet];
}

function extractCveId(vuln) {
  // Check identifiers array first (most reliable)
  for (const id of (vuln.identifiers || [])) {
    if ((id.type || '').toLowerCase() === 'cve') return (id.value || id.name || '').toUpperCase();
  }
  // Legacy top-level cve field
  if (vuln.cve) return vuln.cve.toUpperCase();
  // Fall back to GitLab vuln id
  return `GITLAB-${(vuln.id || 'UNKNOWN').slice(0, 8).toUpperCase()}`;
}

function normalizeSeverity(raw) {
  const map = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'LOW', unknown: 'UNKNOWN' };
  return map[(raw || '').toLowerCase()] || 'UNKNOWN';
}

function extractScore(vuln) {
  if (vuln.cvss_v3 && vuln.cvss_v3.base_score != null) return parseFloat(vuln.cvss_v3.base_score);
  if (vuln.cvss_v2 && vuln.cvss_v2.base_score != null) return parseFloat(vuln.cvss_v2.base_score);
  // identifiers may carry a CVSS score as value
  for (const id of (vuln.identifiers || [])) {
    if ((id.type || '').toLowerCase().includes('cvss') && !isNaN(parseFloat(id.value))) {
      return parseFloat(id.value);
    }
  }
  return 0;
}

function inferEcosystem(filePath) {
  const f = filePath.toLowerCase();
  if (f.endsWith('pom.xml') || f.endsWith('.gradle')) return 'maven';
  if (f.endsWith('go.mod') || f.endsWith('go.sum')) return 'go';
  if (f.endsWith('requirements.txt') || f.endsWith('pipfile') || f.endsWith('setup.py') || f.endsWith('pyproject.toml')) return 'python';
  if (f.endsWith('cargo.toml') || f.endsWith('cargo.lock')) return 'rust';
  if (f.endsWith('.csproj') || f.endsWith('.fsproj') || f.endsWith('.vbproj') || f.endsWith('packages.lock.json') || f.endsWith('directory.packages.props')) return 'dotnet';
  return 'npm';
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like a GitLab Security Report.
 * Signature: { version: string, vulnerabilities: [{ location: { dependency } }] }
 */
function isGitlabFormat(data) {
  if (typeof data.version !== 'string') return false;
  if (!Array.isArray(data.vulnerabilities) || !data.vulnerabilities.length) return false;
  const sample = data.vulnerabilities[0];
  return Boolean(sample.location && sample.location.dependency);
}

function ecosystemToLibraryType(eco) {
  const map = {
    npm:    'NODE_PACKAGED_MODULE',
    maven:  'MAVEN_ARTIFACT',
    python: 'PYTHON_PACKAGE',
    go:     'GO_MODULE',
    dotnet: 'DOTNET_PACKAGE',
    rust:   'RUST_CRATE',
  };
  return map[eco] || 'NODE_PACKAGED_MODULE';
}

function inferFilename(name, version, ecosystem) {
  if (ecosystem === 'maven')  return `${name}-${version}.jar`;
  if (ecosystem === 'python') return `${name}-${version}.tar.gz`;
  if (ecosystem === 'dotnet') return `${name}.${version}.nupkg`;
  if (ecosystem === 'rust')   return `${name}-${version}.crate`;
  return `${name}-${version}.tgz`;
}

function inferDependencyFile(ecosystem) {
  if (ecosystem === 'maven')  return 'pom.xml';
  if (ecosystem === 'python') return 'requirements.txt';
  if (ecosystem === 'go')     return 'go.mod';
  if (ecosystem === 'dotnet') return 'Directory.Packages.props';
  if (ecosystem === 'rust')   return 'Cargo.toml';
  return 'package.json';
}

module.exports = { parseReport, isGitlabFormat, createMR, addMRComment };
