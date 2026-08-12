'use strict';

const path = require('path');
const { parseReport: parseNpmAudit, isNpmAuditFormat } = require('../../src/providers/npm-audit');
const { parseReport: parseDependabot, isDependabotFormat } = require('../../src/providers/dependabot');
const { parseReport: parseOwasp, isOwaspFormat } = require('../../src/providers/owasp');
const { detectProvider, getParser, PROVIDER_NAMES } = require('../../src/providers/index');

const FX = path.join(__dirname, '..', 'fixtures');
const NPM_AUDIT_V2 = path.join(FX, 'npm-audit-v2.json');
const NPM_AUDIT_V1 = path.join(FX, 'npm-audit-v1.json');
const DEPENDABOT   = path.join(FX, 'dependabot-alerts.json');
const OWASP        = path.join(FX, 'owasp-report.json');

// ============================================================================
// npm-audit — format detection
// ============================================================================

describe('isNpmAuditFormat', () => {
  test('detects v2 by auditReportVersion field', () => {
    expect(isNpmAuditFormat({ auditReportVersion: 2, vulnerabilities: {} })).toBe(true);
  });

  test('detects v1 by advisories + metadata shape', () => {
    expect(isNpmAuditFormat({ advisories: {}, metadata: {} })).toBe(true);
  });

  test('does not flag snyk report as npm-audit', () => {
    expect(isNpmAuditFormat({ packageManager: 'npm', vulnerabilities: [] })).toBe(false);
  });

  test('does not flag mend array as npm-audit', () => {
    expect(isNpmAuditFormat({ vulnerabilities: [{ library: {} }] })).toBe(false);
  });
});

// ============================================================================
// npm-audit v2 — parseReport
// ============================================================================

describe('parseReport (npm-audit v2)', () => {
  // No package-lock.json alongside the fixture, so the parser skips packages
  // whose version can't be resolved. In v2 format the range "<4.17.21" has
  // comparison operators so deriveVersionFromExactRange returns null →
  // both packages are skipped without a lock file.
  test('returns empty array when no lock file is present (v2 cannot derive versions)', () => {
    const entries = parseNpmAudit(NPM_AUDIT_V2);
    expect(Array.isArray(entries)).toBe(true);
    // With no adjacent lock file and non-exact ranges, nothing can be resolved
    expect(entries.length).toBe(0);
  });

  test('isNpmAuditFormat returns true for v2 fixture on disk', () => {
    const { readFileSync } = require('fs');
    const data = JSON.parse(readFileSync(NPM_AUDIT_V2, 'utf8'));
    expect(isNpmAuditFormat(data)).toBe(true);
  });
});

// ============================================================================
// npm-audit v1 — parseReport
// ============================================================================

describe('parseReport (npm-audit v1)', () => {
  let entries;
  beforeAll(() => { entries = parseNpmAudit(NPM_AUDIT_V1); });

  test('returns LibraryEntry[] (array)', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('produces one entry per unique (package, version)', () => {
    // lodash@4.17.15, lodash@4.17.4, minimist@1.2.0 = 3 entries
    expect(entries.length).toBe(3);
  });

  test('lodash entries have correct CVE from cves[] array', () => {
    const e = entries.find(x => x.libraryName === 'lodash' && x.currentVersion === '4.17.15');
    expect(e).toBeTruthy();
    expect(e.cves[0].id).toBe('CVE-2021-23337');
    expect(e.cves[0].severity).toBe('HIGH');
    expect(e.cves[0].score).toBeCloseTo(7.2);
    expect(e.cves[0].fixVersions).toEqual(['4.17.21']);
  });

  test('minimist entry uses NPM-id fallback when cves[] is empty', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e).toBeTruthy();
    expect(e.cves[0].id).toMatch(/^NPM-1179$/);
    expect(e.cves[0].fixVersions).toEqual(['1.2.3']);
  });

  test('libraryType is NODE_PACKAGED_MODULE', () => {
    expect(entries.every(e => e.libraryType === 'NODE_PACKAGED_MODULE')).toBe(true);
  });

  test('groupId is null for npm packages', () => {
    expect(entries.every(e => e.groupId === null)).toBe(true);
  });

  test('dependencyFile is package.json', () => {
    expect(entries.every(e => e.dependencyFile === 'package.json')).toBe(true);
  });
});

// ============================================================================
// detectProvider — npm-audit
// ============================================================================

describe('detectProvider for npm-audit', () => {
  test('returns "npm-audit" for v2 fixture', () => {
    expect(detectProvider(NPM_AUDIT_V2)).toBe('npm-audit');
  });

  test('returns "npm-audit" for v1 fixture', () => {
    expect(detectProvider(NPM_AUDIT_V1)).toBe('npm-audit');
  });

  test('getParser("npm-audit") returns parser with parseReport function', () => {
    const parser = getParser('npm-audit');
    expect(typeof parser.parseReport).toBe('function');
  });
});

// ============================================================================
// dependabot — format detection
// ============================================================================

describe('isDependabotFormat', () => {
  test('detects array of alerts with security_advisory + dependency', () => {
    const data = [{ security_advisory: { ghsa_id: 'GHSA-xxx' }, dependency: { package: {} } }];
    expect(isDependabotFormat(data)).toBe(true);
  });

  test('does not flag an empty array', () => {
    expect(isDependabotFormat([])).toBe(false);
  });

  test('does not flag a plain object', () => {
    expect(isDependabotFormat({ vulnerabilities: [] })).toBe(false);
  });

  test('does not flag a Snyk-shaped array', () => {
    const data = [{ packageName: 'lodash', fixedIn: ['4.17.21'] }];
    expect(isDependabotFormat(data)).toBe(false);
  });
});

// ============================================================================
// dependabot — parseReport
// ============================================================================

describe('parseReport (dependabot)', () => {
  let entries;
  beforeAll(() => { entries = parseDependabot(DEPENDABOT); });

  test('returns LibraryEntry[] (array)', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('skips dismissed alerts (only open state included)', () => {
    const names = entries.map(e => e.libraryName);
    expect(names).not.toContain('semver');
  });

  test('skips packages whose version cannot be resolved (no lock file, non-exact range)', () => {
    // Without a lock file adjacent to the fixture, version lookup fails
    // and both lodash and minimist are skipped
    expect(entries.length).toBe(0);
  });

  test('isDependabotFormat returns true for fixture on disk', () => {
    const data = JSON.parse(require('fs').readFileSync(DEPENDABOT, 'utf8'));
    expect(isDependabotFormat(data)).toBe(true);
  });
});

describe('detectProvider for dependabot', () => {
  test('returns "dependabot" for dependabot alerts fixture', () => {
    expect(detectProvider(DEPENDABOT)).toBe('dependabot');
  });

  test('getParser("dependabot") returns parser with parseReport function', () => {
    expect(typeof getParser('dependabot').parseReport).toBe('function');
  });
});

// ============================================================================
// owasp — format detection
// ============================================================================

describe('isOwaspFormat', () => {
  test('detects OWASP report by reportSchema + dependencies', () => {
    expect(isOwaspFormat({ reportSchema: '1.1', dependencies: [] })).toBe(true);
  });

  test('does not flag object without reportSchema', () => {
    expect(isOwaspFormat({ dependencies: [] })).toBe(false);
  });

  test('does not flag object without dependencies array', () => {
    expect(isOwaspFormat({ reportSchema: '1.1', dependencies: 'not-array' })).toBe(false);
  });
});

// ============================================================================
// owasp — parseReport
// ============================================================================

describe('parseReport (owasp)', () => {
  let entries;
  beforeAll(() => { entries = parseOwasp(OWASP); });

  test('returns LibraryEntry[] (array)', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('extracts 3 vulnerable packages (skips clean dependency)', () => {
    expect(entries.length).toBe(3);
  });

  test('npm package — correct name, version, type, and file', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e).toBeTruthy();
    expect(e.currentVersion).toBe('4.17.15');
    expect(e.libraryType).toBe('NODE_PACKAGED_MODULE');
    expect(e.dependencyFile).toBe('package.json');
    expect(e.groupId).toBeNull();
  });

  test('npm package — CVE id, severity, score, and fix version', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].id).toBe('CVE-2021-23337');
    expect(e.cves[0].severity).toBe('HIGH');
    expect(e.cves[0].score).toBeCloseTo(7.2);
    expect(e.cves[0].fixVersions).toEqual(['4.17.21']);
  });

  test('minimist — critical severity and fix version', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e).toBeTruthy();
    expect(e.cves[0].id).toBe('CVE-2020-7598');
    expect(e.cves[0].severity).toBe('CRITICAL');
    expect(e.cves[0].fixVersions).toEqual(['1.2.2']);
  });

  test('Maven artifact — correct libraryType, groupId, and dependencyFile', () => {
    const e = entries.find(x => x.libraryName === 'commons-lang3');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('MAVEN_ARTIFACT');
    expect(e.groupId).toBe('org.apache.commons');
    expect(e.currentVersion).toBe('3.9.0');
    expect(e.dependencyFile).toBe('pom.xml');
    expect(e.cves[0].fixVersions).toEqual(['3.12.0']);
  });
});

describe('detectProvider for owasp', () => {
  test('returns "owasp" for OWASP Dependency-Check fixture', () => {
    expect(detectProvider(OWASP)).toBe('owasp');
  });

  test('getParser("owasp") returns parser with parseReport function', () => {
    expect(typeof getParser('owasp').parseReport).toBe('function');
  });
});

// ============================================================================
// providers/index — general
// ============================================================================

describe('PROVIDER_NAMES', () => {
  test('exports all 9 provider names', () => {
    expect(PROVIDER_NAMES).toEqual(
      expect.arrayContaining(['mend', 'snyk', 'npm-audit', 'dependabot', 'owasp', 'osv', 'trivy', 'gitlab', 'xray'])
    );
    expect(PROVIDER_NAMES.length).toBe(9);
  });
});

describe('getParser error handling', () => {
  test('throws descriptive error for unknown provider', () => {
    expect(() => getParser('unknown-tool')).toThrow(/Unknown provider.*unknown-tool/i);
    expect(() => getParser('unknown-tool')).toThrow(/mend.*snyk.*npm-audit.*dependabot.*owasp/i);
  });
});
