'use strict';

const path = require('path');
const { parseReport, isSnykFormat } = require('../../src/providers/snyk');
const { detectProvider } = require('../../src/providers/index');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const STANDARD = path.join(FIXTURES, 'snyk-report-standard.json');
const ALL_PROJECTS = path.join(FIXTURES, 'snyk-report-all-projects.json');

// ---------------------------------------------------------------------------
// isSnykFormat detection
// ---------------------------------------------------------------------------

describe('isSnykFormat', () => {
  test('detects standard snyk report by packageManager field', () => {
    const data = { packageManager: 'npm', vulnerabilities: [] };
    expect(isSnykFormat(data)).toBe(true);
  });

  test('detects snyk report by vulnerability shape (packageName + fixedIn)', () => {
    const data = {
      vulnerabilities: [{ packageName: 'lodash', version: '4.17.15', fixedIn: ['4.17.21'] }],
    };
    expect(isSnykFormat(data)).toBe(true);
  });

  test('detects all-projects snyk report via projects array', () => {
    const data = {
      projects: [{
        vulnerabilities: [{ packageName: 'minimist', version: '1.2.5', fixedIn: ['1.2.6'] }],
      }],
    };
    expect(isSnykFormat(data)).toBe(true);
  });

  test('does not flag mend report as snyk', () => {
    const data = {
      vulnerabilities: [{ library: { name: 'lodash', version: '4.17.15' } }],
    };
    expect(isSnykFormat(data)).toBe(false);
  });

  test('does not flag empty vulnerabilities as snyk', () => {
    const data = { vulnerabilities: [] };
    expect(isSnykFormat(data)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectProvider integration
// ---------------------------------------------------------------------------

describe('detectProvider', () => {
  test('returns "snyk" for standard snyk JSON', () => {
    expect(detectProvider(STANDARD)).toBe('snyk');
  });

  test('returns "snyk" for all-projects snyk JSON', () => {
    expect(detectProvider(ALL_PROJECTS)).toBe('snyk');
  });
});

// ---------------------------------------------------------------------------
// parseReport — standard format
// ---------------------------------------------------------------------------

describe('parseReport — standard format', () => {
  let entries;
  beforeAll(() => { entries = parseReport(STANDARD); });

  test('returns an array of LibraryEntry objects', () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  test('merges duplicate vulnerabilities for same library into one entry', () => {
    // lodash appears twice in the fixture — should be one LibraryEntry
    const lodash = entries.filter(e => e.libraryName === 'lodash');
    expect(lodash.length).toBe(1);
  });

  test('deduplicates CVE ids within a library', () => {
    // Both lodash vulns map to CVE-2021-23337 — dedup to one cve entry
    const lodash = entries.find(e => e.libraryName === 'lodash');
    const cveIds = lodash.cves.map(c => c.id);
    const unique = [...new Set(cveIds)];
    expect(cveIds.length).toBe(unique.length);
  });

  test('libraryEntry has expected shape', () => {
    const e = entries[0];
    expect(e).toHaveProperty('libraryKey');
    expect(e).toHaveProperty('libraryName');
    expect(e).toHaveProperty('currentVersion');
    expect(e).toHaveProperty('libraryType', 'NODE_PACKAGED_MODULE');
    expect(e).toHaveProperty('groupId', null);
    expect(e).toHaveProperty('dependencyFile', 'package.json');
    expect(Array.isArray(e.cves)).toBe(true);
  });

  test('CVE entry has expected shape', () => {
    const lodash = entries.find(e => e.libraryName === 'lodash');
    const cve = lodash.cves[0];
    expect(cve).toHaveProperty('id', 'CVE-2021-23337');
    expect(cve).toHaveProperty('severity', 'HIGH');
    expect(cve).toHaveProperty('score', 7.4);
    expect(Array.isArray(cve.fixVersions)).toBe(true);
    expect(cve.fixVersions).toContain('4.17.21');
  });

  test('collects all fix versions from fixedIn', () => {
    const axios = entries.find(e => e.libraryName === 'axios');
    expect(axios.cves[0].fixVersions).toEqual(expect.arrayContaining(['0.21.2', '1.6.0']));
  });

  test('falls back to snyk advisory id when cves[] is empty', () => {
    // semver entry has cves: [] in fixture
    const sv = entries.find(e => e.libraryName === 'semver');
    expect(sv.cves[0].id).toBe('SNYK-JS-SEMVER-3247795');
  });

  test('severities are uppercased', () => {
    for (const entry of entries) {
      for (const cve of entry.cves) {
        expect(cve.severity).toBe(cve.severity.toUpperCase());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseReport — all-projects format
// ---------------------------------------------------------------------------

describe('parseReport — all-projects format', () => {
  let entries;
  beforeAll(() => { entries = parseReport(ALL_PROJECTS); });

  test('flattens vulnerabilities across all projects', () => {
    expect(entries.length).toBe(2); // one per unique pkg@version
  });

  test('parses minimist entry correctly', () => {
    const e = entries.find(e => e.libraryName === 'minimist');
    expect(e.currentVersion).toBe('1.2.5');
    expect(e.cves[0].id).toBe('CVE-2021-44906');
    expect(e.cves[0].fixVersions).toContain('1.2.6');
  });

  test('parses node-forge entry correctly', () => {
    const e = entries.find(e => e.libraryName === 'node-forge');
    expect(e.currentVersion).toBe('1.2.1');
    expect(e.cves[0].severity).toBe('MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// parseReport — edge cases
// ---------------------------------------------------------------------------

describe('parseReport — edge cases', () => {
  test('skips entries without packageName or version', () => {
    const tmp = require('os').tmpdir();
    const p = require('path').join(tmp, 'snyk-edge.json');
    const fs = require('fs');
    fs.writeFileSync(p, JSON.stringify({
      packageManager: 'npm',
      vulnerabilities: [
        { id: 'X', severity: 'high', fixedIn: ['1.0.0'] },               // no packageName
        { id: 'Y', packageName: 'pkg', severity: 'high', fixedIn: [] },  // no version
        { id: 'Z', packageName: 'good', version: '1.0.0', severity: 'low', cvssScore: 3.1, fixedIn: ['1.0.1'] },
      ],
    }));
    const result = parseReport(p);
    expect(result.length).toBe(1);
    expect(result[0].libraryName).toBe('good');
    fs.unlinkSync(p);
  });

  test('handles missing cvssScore gracefully (defaults to 0)', () => {
    const tmp = require('os').tmpdir();
    const p = require('path').join(tmp, 'snyk-no-score.json');
    const fs = require('fs');
    fs.writeFileSync(p, JSON.stringify({
      packageManager: 'npm',
      vulnerabilities: [
        { id: 'X', packageName: 'pkg', version: '1.0.0', severity: 'medium', fixedIn: ['1.0.1'] },
      ],
    }));
    const result = parseReport(p);
    expect(result[0].cves[0].score).toBe(0);
    fs.unlinkSync(p);
  });
});
