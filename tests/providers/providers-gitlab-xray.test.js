'use strict';

const path = require('path');
const { parseReport: parseGitlab, isGitlabFormat } = require('../../src/providers/gitlab');
const { parseReport: parseXray, isXrayFormat }     = require('../../src/providers/xray');
const { detectProvider, getParser, PROVIDER_NAMES } = require('../../src/providers/index');

const FX     = path.join(__dirname, '..', 'fixtures');
const GITLAB = path.join(FX, 'gitlab-report.json');
const XRAY   = path.join(FX, 'xray-report.json');

// ============================================================================
// isGitlabFormat — detection
// ============================================================================

describe('isGitlabFormat', () => {
  test('detects GitLab report by version string + vulnerabilities[].location.dependency', () => {
    const data = {
      version: '15.0.4',
      vulnerabilities: [{ location: { dependency: { package: { name: 'lodash' }, version: '4.17.15' } } }],
    };
    expect(isGitlabFormat(data)).toBe(true);
  });

  test('returns false when vulnerabilities array is empty', () => {
    expect(isGitlabFormat({ version: '15.0.4', vulnerabilities: [] })).toBe(false);
  });

  test('returns false when version field is missing', () => {
    const data = { vulnerabilities: [{ location: { dependency: {} } }] };
    expect(isGitlabFormat(data)).toBe(false);
  });

  test('does not flag Trivy output as GitLab (no version string in same shape)', () => {
    const data = { SchemaVersion: 2, Results: [] };
    expect(isGitlabFormat(data)).toBe(false);
  });

  test('does not flag Mend report as GitLab', () => {
    const data = { version: '1.0', vulnerabilities: [{ library: { name: 'lodash' } }] };
    expect(isGitlabFormat(data)).toBe(false); // no location.dependency
  });
});

// ============================================================================
// gitlab — parseReport
// ============================================================================

describe('parseReport (gitlab)', () => {
  let entries;
  beforeAll(() => { entries = parseGitlab(GITLAB); });

  test('returns LibraryEntry array', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('produces entries for npm and maven packages', () => {
    expect(entries.length).toBe(3);
  });

  test('lodash — correct name, version, type, and depFile', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e).toBeTruthy();
    expect(e.currentVersion).toBe('4.17.15');
    expect(e.libraryType).toBe('NODE_PACKAGED_MODULE');
    expect(e.dependencyFile).toBe('package.json');
  });

  test('lodash — CVE from identifiers array (preferred over top-level cve field)', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].id).toBe('CVE-2021-23337');
  });

  test('lodash — fix version from remediations map (highest priority)', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].fixVersions).toContain('4.17.21');
  });

  test('minimist — fix version from solution field when no remediation entry', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e).toBeTruthy();
    expect(e.cves[0].fixVersions).toContain('1.2.6');
    expect(e.cves[0].severity).toBe('CRITICAL');
    expect(e.cves[0].score).toBeCloseTo(9.8);
  });

  test('Maven package — inferred from pom.xml location', () => {
    const e = entries.find(x => x.libraryName === 'commons-lang3');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('MAVEN_ARTIFACT');
    expect(e.dependencyFile).toBe('pom.xml');
  });

  test('CVSS score extracted from cvss_v3.base_score', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].score).toBeCloseTo(7.2);
  });
});

describe('detectProvider for gitlab', () => {
  test('returns "gitlab" for GitLab fixture', () => {
    expect(detectProvider(GITLAB)).toBe('gitlab');
  });

  test('getParser("gitlab") returns parser with parseReport function', () => {
    expect(typeof getParser('gitlab').parseReport).toBe('function');
  });
});

// ============================================================================
// isXrayFormat — detection
// ============================================================================

describe('isXrayFormat', () => {
  test('detects Xray report by data[].components[].component_id', () => {
    const data = { total_count: 1, data: [{ components: [{ component_id: 'npm://lodash:4.17.15' }] }] };
    expect(isXrayFormat(data)).toBe(true);
  });

  test('returns false when data array is empty', () => {
    expect(isXrayFormat({ data: [] })).toBe(false);
  });

  test('returns false when components have no component_id', () => {
    const data = { data: [{ components: [{ package_type: 'npm' }] }] };
    expect(isXrayFormat(data)).toBe(false);
  });

  test('does not flag GitLab report as Xray', () => {
    const data = { version: '15.0.4', vulnerabilities: [] };
    expect(isXrayFormat(data)).toBe(false);
  });
});

// ============================================================================
// xray — parseReport
// ============================================================================

describe('parseReport (xray)', () => {
  let entries;
  beforeAll(() => { entries = parseXray(XRAY); });

  test('returns LibraryEntry array', () => {
    expect(Array.isArray(entries)).toBe(true);
  });

  test('produces 3 entries: 2 npm + 1 maven', () => {
    expect(entries.length).toBe(3);
  });

  test('npm package — name, version, type extracted from component_id "npm://lodash:4.17.15"', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e).toBeTruthy();
    expect(e.currentVersion).toBe('4.17.15');
    expect(e.libraryType).toBe('NODE_PACKAGED_MODULE');
    expect(e.dependencyFile).toBe('package.json');
  });

  test('lodash — CVE id and CVSS score', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].id).toBe('CVE-2021-23337');
    expect(e.cves[0].score).toBeCloseTo(7.2);
    expect(e.cves[0].severity).toBe('HIGH');
  });

  test('lodash — fix version from components[].fixed_versions', () => {
    const e = entries.find(x => x.libraryName === 'lodash');
    expect(e.cves[0].fixVersions).toEqual(['4.17.21']);
  });

  test('minimist — critical severity', () => {
    const e = entries.find(x => x.libraryName === 'minimist');
    expect(e).toBeTruthy();
    expect(e.cves[0].severity).toBe('CRITICAL');
    expect(e.cves[0].fixVersions).toEqual(['1.2.6']);
  });

  test('Maven artifact — parsed from "gav://org.apache.commons:commons-lang3:3.9.0"', () => {
    const e = entries.find(x => x.libraryName === 'commons-lang3');
    expect(e).toBeTruthy();
    expect(e.libraryType).toBe('MAVEN_ARTIFACT');
    expect(e.groupId).toBe('org.apache.commons');
    expect(e.currentVersion).toBe('3.9.0');
    expect(e.cves[0].fixVersions).toEqual(['3.12.0']);
  });
});

// ============================================================================
// xray — component_id parsing edge cases
// ============================================================================

describe('xray component_id edge cases', () => {
  test('npm:// with trailing colons', () => {
    const data = {
      data: [{
        severity: 'High',
        issue_id: 'XRAY-1',
        cves: [{ cve: 'CVE-2021-00001', cvss_v3_score: '7.0' }],
        components: [{ component_id: 'npm://lodash:4.17.15::', fixed_versions: ['4.17.21'] }],
      }],
    };
    const tmpFile = require('os').tmpdir() + '/xray-test.json';
    require('fs').writeFileSync(tmpFile, JSON.stringify(data));
    const entries = parseXray(tmpFile);
    expect(entries.length).toBe(1);
    expect(entries[0].libraryName).toBe('lodash');
    expect(entries[0].currentVersion).toBe('4.17.15');
  });
});

describe('detectProvider for xray', () => {
  test('returns "xray" for Xray fixture', () => {
    expect(detectProvider(XRAY)).toBe('xray');
  });

  test('getParser("xray") returns parser with parseReport function', () => {
    expect(typeof getParser('xray').parseReport).toBe('function');
  });
});

// ============================================================================
// PROVIDER_NAMES — now 9 providers
// ============================================================================

describe('PROVIDER_NAMES (all 9)', () => {
  test('exports all 9 provider names', () => {
    expect(PROVIDER_NAMES).toEqual(
      expect.arrayContaining([
        'mend', 'snyk', 'npm-audit', 'dependabot', 'owasp',
        'osv', 'trivy', 'gitlab', 'xray',
      ])
    );
    expect(PROVIDER_NAMES.length).toBe(9);
  });
});
