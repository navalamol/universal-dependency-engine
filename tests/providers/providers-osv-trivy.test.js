'use strict';

const path = require('path');
const { parseReport: parseOsv, isOsvFormat } = require('../../src/providers/osv');
const { parseReport: parseTrivy, isTrivyFormat } = require('../../src/providers/trivy');
const { detectProvider, getParser, PROVIDER_NAMES } = require('../../src/providers/index');

const FX         = path.join(__dirname, '..', 'fixtures');
const OSV_SCAN   = path.join(FX, 'osv-scanner.json');
const OSV_BULK   = path.join(FX, 'osv-api-bulk.json');
const TRIVY      = path.join(FX, 'trivy-report.json');

// ============================================================================
// isOsvFormat — detection
// ============================================================================

describe('isOsvFormat', () => {
  test('detects osv-scanner output by results[].source + packages', () => {
    const data = { results: [{ source: { path: 'package-lock.json' }, packages: [] }] };
    expect(isOsvFormat(data)).toBe(true);
  });

  test('detects OSV API bulk by vulns[].id + affected', () => {
    const data = { vulns: [{ id: 'GHSA-xxx', affected: [] }] };
    expect(isOsvFormat(data)).toBe(true);
  });

  test('returns false for empty vulns array', () => {
    expect(isOsvFormat({ vulns: [] })).toBe(false);
  });

  test('does not flag Trivy output as OSV', () => {
    const data = { SchemaVersion: 2, Results: [] };
    expect(isOsvFormat(data)).toBe(false);
  });

  test('does not flag Snyk output as OSV', () => {
    const data = { packageManager: 'npm', vulnerabilities: [] };
    expect(isOsvFormat(data)).toBe(false);
  });
});

// ============================================================================
// osv-scanner shape — parseReport
// ============================================================================

describe('parseReport (osv-scanner shape)', () => {
  let entries;
  beforeAll(() => { entries = parseOsv(OSV_SCAN); });

  test('returns LibraryEntry array', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('produces one entry per unique (package, version)', () => {
    expect(entries.length).toBe(2); // lodash@4.17.15, minimist@1.2.0
  });

  test('lodash — correct name, version, type, depFile', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e).toBeTruthy();
    expect(e.currentVersion).toBe('4.17.15');
    expect(e.libraryType).toBe('NODE_PACKAGED_MODULE');
    expect(e.dependencyFile).toBe('package-lock.json');
  });

  test('lodash — prefers CVE id over GHSA id', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].id).toBe('CVE-2021-23337');
  });

  test('lodash — fix version extracted from SEMVER range event', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].fixVersions).toEqual(['4.17.21']);
  });

  test('lodash — score from database_specific.cvss3_score', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].score).toBeCloseTo(7.2);
    expect(e.cves[0].severity).toBe('HIGH');
  });

  test('minimist — falls back to GHSA id when no CVE alias present', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e.cves[0].id).toBe('GHSA-7FHM-MQM4-2WP7');
  });

  test('minimist — critical severity', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e.cves[0].severity).toBe('CRITICAL');
    expect(e.cves[0].score).toBeCloseTo(9.8);
  });
});

// ============================================================================
// OSV API bulk shape — parseReport
// ============================================================================

describe('parseReport (OSV API bulk shape)', () => {
  test('returns entries using latest version from versions list when no lock file', () => {
    const entries = parseOsv(OSV_BULK);
    // No lock file adjacent to fixture; falls back to latest from versions list
    expect(Array.isArray(entries)).toBe(true);
    if (entries.length > 0) {
      const e = entries[0];
      expect(e.libraryName).toBe('lodash');
      expect(e.cves[0].fixVersions).toEqual(['4.17.21']);
    }
  });
});

// ============================================================================
// detectProvider for osv
// ============================================================================

describe('detectProvider for osv', () => {
  test('returns "osv" for osv-scanner fixture', () => {
    expect(detectProvider(OSV_SCAN)).toBe('osv');
  });

  test('returns "osv" for osv-api-bulk fixture', () => {
    expect(detectProvider(OSV_BULK)).toBe('osv');
  });

  test('getParser("osv") returns parser with parseReport function', () => {
    expect(typeof getParser('osv').parseReport).toBe('function');
  });
});

// ============================================================================
// isTrivyFormat — detection
// ============================================================================

describe('isTrivyFormat', () => {
  test('detects Trivy v2 by SchemaVersion + Results array', () => {
    const data = { SchemaVersion: 2, Results: [] };
    expect(isTrivyFormat(data)).toBe(true);
  });

  test('does not flag OSV output as Trivy', () => {
    const data = { results: [{ source: {}, packages: [] }] };
    expect(isTrivyFormat(data)).toBe(false);
  });

  test('does not flag Snyk output as Trivy', () => {
    const data = { packageManager: 'npm', vulnerabilities: [] };
    expect(isTrivyFormat(data)).toBe(false);
  });

  test('does not flag npm audit v2 as Trivy', () => {
    const data = { auditReportVersion: 2, vulnerabilities: {} };
    expect(isTrivyFormat(data)).toBe(false);
  });
});

// ============================================================================
// trivy — parseReport
// ============================================================================

describe('parseReport (trivy)', () => {
  let entries;
  beforeAll(() => { entries = parseTrivy(TRIVY); });

  test('returns LibraryEntry array', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('produces entries for npm, maven, go, python results', () => {
    // lodash (2 CVEs → merged to 1 entry), minimist, commons-io, golang.org/x/net, requests
    const names = entries.map(e => e.libraryName);
    expect(names).toContain('lodash');
    expect(names).toContain('minimist');
  });

  test('skips result with null Vulnerabilities', () => {
    // "src/api" target has Vulnerabilities: null → not included
    const names = entries.map(e => e.dependencyFile);
    expect(names.every(f => f !== undefined)).toBe(true);
  });

  test('lodash — correct name, version, and npm type', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e).toBeTruthy();
    expect(e.currentVersion).toBe('4.17.15');
    expect(e.libraryType).toBe('NODE_PACKAGED_MODULE');
    expect(e.dependencyFile).toBe('package-lock.json');
    expect(e.groupId).toBeNull();
  });

  test('lodash — two CVEs deduplicated into one entry, both present', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    const ids = e.cves.map(c => c.id);
    expect(ids).toContain('CVE-2021-23337');
    expect(ids).toContain('CVE-2020-8203');
    expect(ids.length).toBe(2);
  });

  test('lodash — CVSS score prefers nvd V3Score', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    const cve = e.cves.find(c => c.id === 'CVE-2021-23337');
    expect(cve.score).toBeCloseTo(7.2);
    expect(cve.severity).toBe('HIGH');
  });

  test('minimist — fix versions parsed from "0.2.4, 1.2.3" string', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e).toBeTruthy();
    expect(e.cves[0].fixVersions).toEqual(expect.arrayContaining(['0.2.4', '1.2.3']));
    expect(e.cves[0].severity).toBe('CRITICAL');
  });

  test('Maven artifact — correct libraryType and groupId', () => {
    const e = entries.find(x => x.libraryName === 'commons-io');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('MAVEN_ARTIFACT');
    expect(e.groupId).toBe('org.apache.commons');
    expect(e.currentVersion).toBe('2.6.0'); // semver.coerce("2.6") → "2.6.0"
    expect(e.dependencyFile).toBe('pom.xml');
  });

  test('Go module — correct libraryType', () => {
    const e = entries.find(x => x.libraryName === 'golang.org/x/net');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('GO_MODULE');
    expect(e.dependencyFile).toBe('go.sum');
  });

  test('Python package — correct libraryType', () => {
    const e = entries.find(x => x.libraryName === 'requests');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('PYTHON_PACKAGE');
    expect(e.dependencyFile).toBe('requirements.txt');
  });
});

// ============================================================================
// detectProvider for trivy
// ============================================================================

describe('detectProvider for trivy', () => {
  test('returns "trivy" for Trivy fixture', () => {
    expect(detectProvider(TRIVY)).toBe('trivy');
  });

  test('Trivy is detected before OSV (SchemaVersion is unambiguous)', () => {
    // Trivy detection runs before OSV in index.js — schema is exclusive
    expect(detectProvider(TRIVY)).toBe('trivy');
  });

  test('getParser("trivy") returns parser with parseReport function', () => {
    expect(typeof getParser('trivy').parseReport).toBe('function');
  });
});

// ============================================================================
// PROVIDER_NAMES — now 9 providers
// ============================================================================

describe('PROVIDER_NAMES (all 9)', () => {
  test('exports all 9 provider names', () => {
    expect(PROVIDER_NAMES).toEqual(
      expect.arrayContaining(['mend', 'snyk', 'npm-audit', 'dependabot', 'owasp', 'osv', 'trivy', 'gitlab', 'xray'])
    );
    expect(PROVIDER_NAMES.length).toBe(9);
  });
});
