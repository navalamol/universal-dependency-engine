'use strict';

const fs = require('fs');
const semver = require('semver');

/**
 * Parse a Trivy JSON report into LibraryEntry[].
 *
 * Input: `trivy fs --format json --scanners vuln .` or
 *         `trivy image --format json <image>`
 *
 * Trivy JSON schema v2:
 *   {
 *     SchemaVersion: 2,
 *     ArtifactName: ".",
 *     Results: [
 *       {
 *         Target: "package-lock.json",
 *         Class: "lang-pkgs",
 *         Type: "node-pkg",
 *         Vulnerabilities: [
 *           {
 *             VulnerabilityID: "CVE-2021-23337",
 *             PkgName: "lodash",
 *             InstalledVersion: "4.17.15",
 *             FixedVersion: "4.17.21",
 *             Severity: "HIGH",
 *             CVSS: { nvd: { V3Score: 7.2 }, redhat: { V3Score: 7.0 } }
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Trivy is the cleanest provider: InstalledVersion and FixedVersion are both
 * embedded — no lock file cross-reference needed.
 *
 * Multi-ecosystem: Trivy reports can contain npm, Maven, Python, Go entries in
 * the same file. This parser captures all supported types (npm + Maven). Python
 * and Go entries are emitted with a PYTHON_PACKAGE / GO_MODULE libraryType so
 * the ecosystem layer can filter unsupported types rather than silently dropping.
 *
 * FixedVersion edge cases:
 *   - "4.17.21"          → one fix version
 *   - "4.17.21, 5.0.0"  → two fix versions (Trivy sometimes lists both branches)
 *   - ""                 → no fix available → []
 */
function parseReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw.Results)) return [];

  const byKey = new Map();

  for (const result of raw.Results) {
    if (!Array.isArray(result.Vulnerabilities) || !result.Vulnerabilities.length) continue;

    const resultType = (result.Type || '').toLowerCase();
    const depFile    = result.Target || 'unknown';

    for (const vuln of result.Vulnerabilities) {
      const name    = vuln.PkgName || '';
      const version = vuln.InstalledVersion || '';
      if (!name || !version) continue;

      // Skip entries with no valid semver version (OS packages, image layers, etc.)
      if (!semver.valid(version) && !semver.valid(semver.coerce(version))) continue;
      const resolvedVersion = semver.valid(version) || semver.valid(semver.coerce(version));

      const libraryType  = resultTypeToLibraryType(resultType, vuln);
      const fixVersions  = parseFixedVersion(vuln.FixedVersion);
      const cveId        = vuln.VulnerabilityID || `TRIVY-${name}`;
      const severity     = (vuln.Severity || '').toUpperCase() || 'UNKNOWN';
      const score        = extractCvssScore(vuln.CVSS);

      const mavenGroupId = libraryType === 'MAVEN_ARTIFACT'
        ? extractMavenGroup(name, vuln.PkgID)
        : null;

      // Trivy may include the group in PkgName as "group:artifact" for Maven
      const libName = libraryType === 'MAVEN_ARTIFACT' ? extractMavenArtifact(name) : name;

      const key = `${libName}@${resolvedVersion}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          libraryKey:     key,
          libraryName:    libName,
          groupId:        mavenGroupId,
          libraryType,
          currentVersion: resolvedVersion,
          filename:       vuln.PkgID || inferFilename(libName, resolvedVersion, libraryType),
          dependencyFile: inferDependencyFile(depFile, libraryType),
          cves:           [],
        });
      }

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

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map Trivy result Type to our LibraryEntry libraryType.
 *
 * npm/node types   → NODE_PACKAGED_MODULE
 * Maven types      → MAVEN_ARTIFACT
 * Python types     → PYTHON_PACKAGE
 * Go types         → GO_MODULE
 * NuGet types      → DOTNET_PACKAGE
 * Rust/Cargo types → RUST_CRATE
 * Unknown          → NODE_PACKAGED_MODULE (safe default for lang-pkgs)
 */
function resultTypeToLibraryType(type, vuln) {
  // Infer from VulnerabilityID prefix as a secondary signal
  const idPrefix = (vuln.VulnerabilityID || '').slice(0, 3).toUpperCase();

  if (['node-pkg', 'npm', 'yarn', 'pnpm', 'bun'].includes(type)) return 'NODE_PACKAGED_MODULE';
  if (['pom', 'maven', 'gradle'].includes(type)) return 'MAVEN_ARTIFACT';
  if (['pip', 'pipenv', 'poetry', 'python-pkg', 'python'].includes(type)) return 'PYTHON_PACKAGE';
  if (['gomod', 'gobinary', 'go'].includes(type)) return 'GO_MODULE';
  if (['cargo', 'rust'].includes(type)) return 'RUST_CRATE';
  if (['nuget', 'dotnet-core', 'dotnet', 'msbuild'].includes(type)) return 'DOTNET_PACKAGE';
  if (['gem', 'bundler'].includes(type)) return 'RUBY_GEM';
  if (type.includes('maven') || type.includes('java')) return 'MAVEN_ARTIFACT';
  if (type.includes('node') || type.includes('npm')) return 'NODE_PACKAGED_MODULE';

  // Fall back to NODE_PACKAGED_MODULE for unknown lang-pkgs
  return 'NODE_PACKAGED_MODULE';
}

/**
 * Parse Trivy FixedVersion string into an array of semver versions.
 * Handles: "", "4.17.21", "4.17.21, 5.0.0", "4.17.21 5.0.0"
 */
function parseFixedVersion(fixedVersion) {
  if (!fixedVersion) return [];
  // Split on comma or whitespace
  return fixedVersion
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => semver.valid(semver.coerce(s)))
    .filter(Boolean);
}

/**
 * Extract the best available CVSS score from Trivy's CVSS map.
 * Prefers V3Score from nvd, then redhat, then any source, then V2Score.
 */
function extractCvssScore(cvss) {
  if (!cvss || typeof cvss !== 'object') return 0;
  // Prefer NVD V3
  if (cvss.nvd && cvss.nvd.V3Score != null) return parseFloat(cvss.nvd.V3Score);
  // Any source V3
  for (const source of Object.values(cvss)) {
    if (source && source.V3Score != null) return parseFloat(source.V3Score);
  }
  // Fall back to V2
  if (cvss.nvd && cvss.nvd.V2Score != null) return parseFloat(cvss.nvd.V2Score);
  for (const source of Object.values(cvss)) {
    if (source && source.V2Score != null) return parseFloat(source.V2Score);
  }
  return 0;
}

/**
 * For Maven packages, Trivy may use "group:artifact" in PkgName.
 * Extract the group portion, falling back to PkgID ("group:artifact:ver").
 */
function extractMavenGroup(pkgName, pkgId) {
  const colon = pkgName.indexOf(':');
  if (colon >= 0) return pkgName.slice(0, colon);
  if (pkgId) {
    const parts = pkgId.split(':');
    if (parts.length >= 2) return parts[0];
  }
  return null;
}

function extractMavenArtifact(pkgName) {
  const colon = pkgName.indexOf(':');
  return colon >= 0 ? pkgName.slice(colon + 1) : pkgName;
}

function inferFilename(name, version, libraryType) {
  if (libraryType === 'MAVEN_ARTIFACT') return `${name}-${version}.jar`;
  if (libraryType === 'PYTHON_PACKAGE') return `${name}-${version}.tar.gz`;
  return `${name}-${version}.tgz`;
}

function inferDependencyFile(target, libraryType) {
  // target is the Trivy Result.Target (e.g., "package-lock.json", "pom.xml", "go.sum")
  if (target && target !== 'unknown') return target;
  if (libraryType === 'MAVEN_ARTIFACT') return 'pom.xml';
  if (libraryType === 'GO_MODULE') return 'go.mod';
  if (libraryType === 'PYTHON_PACKAGE') return 'requirements.txt';
  return 'package.json';
}

// ---------------------------------------------------------------------------
// Format detection (called from providers/index.js)
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed JSON looks like a Trivy v2 JSON report.
 * Signature: { SchemaVersion: number, Results: array }
 */
function isTrivyFormat(data) {
  return typeof data.SchemaVersion === 'number' && Array.isArray(data.Results);
}

module.exports = { parseReport, isTrivyFormat };
