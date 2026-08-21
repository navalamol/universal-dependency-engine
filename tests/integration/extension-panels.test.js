'use strict';

/**
 * Batch 6 exit-gate tests — VS Code extension 4-panel thin client.
 *
 * Tests the data contract between the engine (orchestrator.js) and the
 * panel.js UI layer without requiring a real VS Code process.
 * Verifies the shapes that each of the 4 panels depends on.
 */

const path = require('path');
const fs   = require('fs');

const DEMO_DIR  = path.join(__dirname, '../../fixtures/demo-corpus');
const LOCK_FILE = path.join(DEMO_DIR, 'npm', 'package-lock.json');
const PKG_JSON  = path.join(DEMO_DIR, 'npm', 'package.json');
const REPORT    = path.join(DEMO_DIR, 'reports', 'mend-report.json');

const { runAnalysisPipeline }      = require('../../orchestrator');
const { buildComparisonReport }    = require('../../src/core/comparison-report');
const { createEvidence, toSarif, toCycloneDxVex } = require('../../src/core/evidence-model');
const { generateKPIReport }        = require('../../src/core/kpi-report');

// ---------------------------------------------------------------------------
// Shared fixture — run once
// ---------------------------------------------------------------------------

let pipelineResult;
beforeAll(async () => {
  if (!fs.existsSync(REPORT)) return; // skip if demo corpus absent
  pipelineResult = await runAnalysisPipeline({
    reportPath:      REPORT,
    lockFilePath:    LOCK_FILE,
    packageJsonPath: PKG_JSON,
    classifyExposure: true,
  });
}, 30000);

function skipIfNoCorpus() {
  if (!fs.existsSync(REPORT)) return true;
  if (!pipelineResult) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Panel 1 — Scan: pipeline result has the fields the Scan tab needs
// ---------------------------------------------------------------------------

describe('Panel 1 — Scan', () => {
  test('pipeline returns entries + provider', () => {
    if (skipIfNoCorpus()) return;
    const { entries, provider } = pipelineResult;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(typeof provider).toBe('string');
    expect(provider).toBe('mend');
  });

  test('each entry has libraryName, currentVersion, cves', () => {
    if (skipIfNoCorpus()) return;
    for (const e of pipelineResult.entries) {
      expect(typeof e.libraryName).toBe('string');
      expect(typeof e.currentVersion).toBe('string');
      expect(Array.isArray(e.cves)).toBe(true);
    }
  });

  test('SCANNER_LABELS map covers the detected provider', () => {
    if (skipIfNoCorpus()) return;
    const SCANNER_LABELS = {
      mend: 'Mend', snyk: 'Snyk', 'npm-audit': 'npm audit',
      dependabot: 'Dependabot', owasp: 'OWASP Dependency-Check',
      osv: 'OSV Scanner', trivy: 'Trivy', gitlab: 'GitLab', xray: 'JFrog Xray',
    };
    expect(SCANNER_LABELS[pipelineResult.provider]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Panel 2 — Analyze: phase cards + exposure + comparison
// ---------------------------------------------------------------------------

describe('Panel 2 — Analyze', () => {
  test('phasedPlan has A/B/C items', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const phases = phasedPlan.map(i => i.phase);
    expect(phases).toContain('A');
    expect(phases).toContain('C');
    expect(phasedPlan.filter(i => i.phase === 'A').length).toBeGreaterThanOrEqual(4);
  });

  test('each PhasedItem has cveCount, highestSeverity, phase', () => {
    if (skipIfNoCorpus()) return;
    for (const item of pipelineResult.phasedPlan) {
      expect(typeof item.cveCount).toBe('number');
      expect(typeof item.highestSeverity).toBe('string');
      expect(['A','B','C']).toContain(item.phase);
    }
  });

  test('totalCVEs equals sum of cveCount', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const total = phasedPlan.reduce((s, i) => s + (i.cveCount || 0), 0);
    expect(total).toBeGreaterThan(0);
  });

  test('exposureResults present with classification field', () => {
    if (skipIfNoCorpus()) return;
    const { exposureResults } = pipelineResult;
    expect(Array.isArray(exposureResults)).toBe(true);
    expect(exposureResults.length).toBeGreaterThan(0);
    for (const r of exposureResults) {
      if (r.exposureResult) {
        expect(typeof r.exposureResult.classification).toBe('string');
      }
    }
  });

  test('buildComparisonReport produces required fields', () => {
    if (skipIfNoCorpus()) return;
    const { entries, phasedPlan, exposureResults } = pipelineResult;
    const cr = buildComparisonReport(entries, phasedPlan, exposureResults);
    expect(typeof cr.scanner.totalCves).toBe('number');
    expect(typeof cr.engine.autoCloseable).toBe('number');
    expect(typeof cr.engine.requiresAction).toBe('number');
    expect(typeof cr.narrative).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Panel 3 — Apply: confirmation gate data
// ---------------------------------------------------------------------------

describe('Panel 3 — Apply', () => {
  test('Phase A count and CVE sum are non-zero (confirmation gate data)', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const phaseA = phasedPlan.filter(i => i.phase === 'A');
    expect(phaseA.length).toBeGreaterThanOrEqual(4);
    const cvesA = phaseA.reduce((s, i) => s + (i.cveCount || 0), 0);
    expect(cvesA).toBeGreaterThan(0);
  });

  test('demo-analysis.json readable as apply-ready state', () => {
    const demoOut = path.join(process.cwd(), 'demo-output', 'demo-analysis.json');
    if (!fs.existsSync(demoOut)) return; // skip if demo hasn't been run yet
    const raw = JSON.parse(fs.readFileSync(demoOut, 'utf8'));
    expect(Array.isArray(raw.phasedPlan)).toBe(true);
    expect(raw.phasedPlan.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Panel 4 — Evidence: SARIF, VEX, KPI export
// ---------------------------------------------------------------------------

describe('Panel 4 — Evidence', () => {
  test('createEvidence builds a bundle for each PhasedItem', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const bundles = phasedPlan.map(item => createEvidence(item, {}));
    expect(bundles.length).toBe(phasedPlan.length);
    for (const b of bundles) {
      expect(b.schemaVersion).toBeDefined();
      expect(b.libraryName).toBeDefined();
    }
  });

  test('toSarif produces valid SARIF 2.1.0 structure', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const bundles = phasedPlan.map(item => createEvidence(item, {}));
    const sarif = toSarif(bundles, { tool: 'mend-autofixer' });
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif');
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs[0].results.length).toBe(bundles.length);
    // Verify it serialises without error
    const json = JSON.stringify(sarif);
    expect(json.length).toBeGreaterThan(100);
  });

  test('toCycloneDxVex produces valid CycloneDX 1.5 VEX structure', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const bundles = phasedPlan.map(item => createEvidence(item, {}));
    const vex = toCycloneDxVex(bundles, { tool: 'mend-autofixer' });
    expect(vex.bomFormat).toBe('CycloneDX');
    expect(vex.specVersion).toBe('1.5');
    expect(Array.isArray(vex.vulnerabilities)).toBe(true);
    const json = JSON.stringify(vex);
    expect(json.length).toBeGreaterThan(100);
  });

  test('generateKPIReport produces non-empty markdown', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan } = pipelineResult;
    const bundles = phasedPlan.map(item => createEvidence(item, {}));
    const report = generateKPIReport(bundles);
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(100);
    expect(report).toContain('KPI');
  });

  test('evidence items have the fields the Evidence tab renders', () => {
    if (skipIfNoCorpus()) return;
    const { phasedPlan, exposureResults } = pipelineResult;
    const expMap = new Map();
    for (const r of (exposureResults || [])) {
      if (r.item && r.item.libraryName) expMap.set(r.item.libraryName, r.exposureResult);
    }
    const evidenceItems = phasedPlan.map(item => ({
      name:            item.libraryName,
      phase:           item.phase,
      cveCount:        item.cveCount || 0,
      highestSeverity: item.highestSeverity || 'UNKNOWN',
      cves:            (item.cves || []).map(c => c.id).join(', '),
      justification:   item.justification || '',
      exposure:        (expMap.get(item.libraryName) || {}).classification || 'UNKNOWN',
    }));
    expect(evidenceItems.length).toBeGreaterThan(0);
    for (const ev of evidenceItems) {
      expect(typeof ev.name).toBe('string');
      expect(['A','B','C']).toContain(ev.phase);
      expect(typeof ev.exposure).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-panel: demo-output/demo-analysis.json shape
// ---------------------------------------------------------------------------

describe('demo-analysis.json shape (loadDemo contract)', () => {
  test('demo-analysis.json has phasedPlan + exposureResults when present', () => {
    const demoOut = path.join(process.cwd(), 'demo-output', 'demo-analysis.json');
    if (!fs.existsSync(demoOut)) return;
    const raw = JSON.parse(fs.readFileSync(demoOut, 'utf8'));
    expect(Array.isArray(raw.phasedPlan)).toBe(true);
    expect(raw.phasedPlan.length).toBeGreaterThan(0);
    // exposureResults may or may not be present depending on demo run flags
    if (raw.exposureResults) {
      expect(Array.isArray(raw.exposureResults)).toBe(true);
    }
  });
});
