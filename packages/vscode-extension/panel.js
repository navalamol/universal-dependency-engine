'use strict';

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');

const ORCHESTRATOR_PATH    = path.join(__dirname, '../../orchestrator.js');
const ENGINE_CLI_PATH      = path.join(__dirname, '../../mendfix.js');
const COMPARISON_REPORT    = path.join(__dirname, '../../src/core/comparison-report.js');
const EVIDENCE_MODEL_PATH  = path.join(__dirname, '../../src/core/evidence-model.js');
const KPI_REPORT_PATH      = path.join(__dirname, '../../src/core/kpi-report.js');

const SCANNER_LABELS = {
  mend:        'Mend',
  snyk:        'Snyk',
  'npm-audit': 'npm audit',
  dependabot:  'Dependabot',
  owasp:       'OWASP Dependency-Check',
  osv:         'OSV Scanner',
  trivy:       'Trivy',
  gitlab:      'GitLab',
  xray:        'JFrog Xray',
};

class MendFixViewProvider {
  static viewType = 'mendfix.panel';

  constructor(context) {
    this._context = context;
    this._view    = undefined;
    this._pendingFile   = undefined;
    this._lastAnalysis  = null;  // { phasedPlan, entries, provider, exposureResults, reportPath, lockPath }
    this._snapshot      = null;  // files snapshot for rollback
    this._outDir        = './mendfix-output';
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._sendInit();
          if (this._pendingFile) {
            this._view.webview.postMessage({ type: 'filePicked', path: this._pendingFile });
            this._pendingFile = undefined;
          }
          break;
        case 'browse':        await this._handleBrowse(); break;
        case 'browsePkg':     await this._handleBrowseFile('packageJson', 'Select package.json'); break;
        case 'browseLock':    await this._handleBrowseFile('lockFile', 'Select package-lock.json'); break;
        case 'analyze':       await this._handleAnalyze(msg); break;
        case 'apply':         await this._handleApply(msg); break;
        case 'export':        await this._handleExport(msg); break;
        case 'rollback':      await this._handleRollback(msg); break;
        case 'loadDemo':      await this._handleLoadDemo(msg); break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mendfix.mendfix-vscode');
          break;
      }
    });
  }

  loadFile(fsPath) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'filePicked', path: fsPath });
    } else {
      this._pendingFile = fsPath;
    }
  }

  async loadDemoOutput() {
    const demoPath = path.join(process.cwd(), 'demo-output', 'demo-analysis.json');
    if (fs.existsSync(demoPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
        await this._dispatchAnalysisResult(raw.phasedPlan, raw.entries || [], 'mend', raw.exposureResults || []);
      } catch (e) {
        if (this._view) this._view.webview.postMessage({ type: 'error', message: 'Failed to load demo output: ' + e.message });
      }
    } else {
      vscode.window.showWarningMessage('Demo output not found. Run `mendfix demo` first.');
    }
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  _sendInit() {
    const cfg = vscode.workspace.getConfiguration('mendfix');
    this._outDir = cfg.get('outDir', './mendfix-output');
    this._view.webview.postMessage({
      type: 'init',
      settings: {
        packageJson:    cfg.get('packageJson', ''),
        lockFile:       cfg.get('lockFile', ''),
        ecosystem:      cfg.get('ecosystem', 'auto'),
        applyPhaseB:    cfg.get('applyPhaseB', false),
        dryRun:         cfg.get('dryRun', false),
        verifyVersions: cfg.get('verifyVersions', false),
        outDir:         this._outDir,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Browse helpers
  // ---------------------------------------------------------------------------

  async _handleBrowse() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'JSON Reports': ['json'] },
      openLabel: 'Select Vulnerability Report',
    });
    if (uris && uris[0]) {
      this._view.webview.postMessage({ type: 'filePicked', path: uris[0].fsPath });
    }
  }

  async _handleBrowseFile(field, label) {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: label });
    if (uris && uris[0]) {
      this._view.webview.postMessage({ type: 'fieldPicked', field, path: uris[0].fsPath });
    }
  }

  // ---------------------------------------------------------------------------
  // Analyze — Panel 1 → Panel 2 transition
  // ---------------------------------------------------------------------------

  async _handleAnalyze(msg) {
    const { reportPath, verifyVersions, lockPath } = msg;
    this._view.webview.postMessage({ type: 'thinking' });

    try {
      const { runAnalysisPipeline } = require(ORCHESTRATOR_PATH);
      const result = await runAnalysisPipeline({
        reportPath,
        verifyVersions: !!verifyVersions,
        lockFilePath:   lockPath || null,
        classifyExposure: true,
      });
      const { phasedPlan, entries, provider, exposureResults } = result;
      await this._dispatchAnalysisResult(phasedPlan, entries, provider, exposureResults || [], reportPath, lockPath);
    } catch (err) {
      const isNotFound = err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT';
      this._view.webview.postMessage({
        type: 'error',
        errorKind: isNotFound ? 'notfound' : 'unknown',
        message: err.message,
      });
    }
  }

  async _dispatchAnalysisResult(phasedPlan, entries, provider, exposureResults, reportPath, lockPath) {
    this._lastAnalysis = { phasedPlan, entries, provider, exposureResults, reportPath, lockPath };

    const phaseA    = phasedPlan.filter(i => i.phase === 'A');
    const phaseB    = phasedPlan.filter(i => i.phase === 'B');
    const phaseC    = phasedPlan.filter(i => i.phase === 'C');
    const totalCVEs = phasedPlan.reduce((s, i) => s + (i.cveCount || 0), 0);

    const toRow = (i) => ({
      name:            i.libraryName,
      current:         i.currentVersion,
      recommended:     i.recommendedVersion || '—',
      upgradeType:     i.upgradeType,
      cveCount:        i.cveCount || 0,
      highestSeverity: i.highestSeverity || 'UNKNOWN',
      phase:           i.phase,
      justification:   i.justification || '',
    });

    const exposureSummary = this._buildExposureSummary(exposureResults);

    let comparison = null;
    try {
      const { buildComparisonReport } = require(COMPARISON_REPORT);
      const cr = buildComparisonReport(entries, phasedPlan, exposureResults);
      comparison = {
        scannerTotal:          cr.scanner.totalCves,
        engineAutoClose:       cr.engine.autoCloseable,
        engineRequiresAction:  cr.engine.requiresAction,
        engineNotProdReachable: cr.engine.notProductionReachable,
        narrative:             cr.narrative,
      };
    } catch (_) { /* comparison is optional */ }

    const evidenceItems = this._buildEvidenceItems(phasedPlan, exposureResults);
    const scannerName   = SCANNER_LABELS[provider] || provider || 'Unknown';

    this._view.webview.postMessage({
      type: 'result',
      data: {
        scanner:        scannerName,
        totalLibraries: phasedPlan.length,
        totalCVEs,
        libraryRows:    phasedPlan.map(toRow),
        phaseA:         phaseA.map(toRow),
        phaseB:         phaseB.map(toRow),
        phaseC:         phaseC.map(toRow),
        phaseACveCount: phaseA.reduce((s, i) => s + (i.cveCount || 0), 0),
        phaseBCveCount: phaseB.reduce((s, i) => s + (i.cveCount || 0), 0),
        phaseCCveCount: phaseC.reduce((s, i) => s + (i.cveCount || 0), 0),
        exposureSummary,
        comparison,
        evidenceItems,
      },
    });
  }

  _buildExposureSummary(exposureResults) {
    if (!exposureResults || !exposureResults.length) return null;
    const summary = { runtimeReachable: 0, testOnly: 0, buildTime: 0, ciOnly: 0, unknown: 0 };
    const DEV_CLASSES = new Set(['TEST_ONLY', 'LOCAL_TOOLING_ONLY', 'CI_EXECUTED', 'BUILD_TIME_EXECUTED']);
    for (const r of exposureResults) {
      const cls = r.exposureResult && r.exposureResult.classification;
      if (!cls) { summary.unknown++; continue; }
      if (cls === 'RUNTIME_REACHABLE')             summary.runtimeReachable++;
      else if (cls === 'CI_EXECUTED')              summary.ciOnly++;
      else if (cls === 'BUILD_TIME_EXECUTED')      summary.buildTime++;
      else if (DEV_CLASSES.has(cls))               summary.testOnly++;
      else                                         summary.unknown++;
    }
    return summary;
  }

  _buildEvidenceItems(phasedPlan, exposureResults) {
    const expMap = new Map();
    for (const r of (exposureResults || [])) {
      if (r.item && r.item.libraryName) expMap.set(r.item.libraryName, r.exposureResult);
    }
    return phasedPlan.map(item => ({
      name:            item.libraryName,
      phase:           item.phase,
      cveCount:        item.cveCount || 0,
      highestSeverity: item.highestSeverity || 'UNKNOWN',
      cves:            (item.cves || []).map(c => c.id).join(', '),
      justification:   item.justification || '',
      evidence:        item.evidence || '',
      alternative:     item.alternative || '',
      exposure:        (expMap.get(item.libraryName) || {}).classification || 'UNKNOWN',
      upgradeType:     item.upgradeType,
      current:         item.currentVersion,
      recommended:     item.recommendedVersion || '—',
    }));
  }

  // ---------------------------------------------------------------------------
  // Apply — Panel 3 (CLI spawn, streams output)
  // ---------------------------------------------------------------------------

  async _handleApply(msg) {
    const { reportPath, pkgPath, lockPath, ecosystem,
            applyPhaseB, dryRun, verifyVersions, outDir } = msg;

    if (!reportPath) {
      this._view.webview.postMessage({ type: 'applyError', message: 'No report selected. Run Analyze first.' });
      return;
    }

    const resolvedOutDir = outDir || this._outDir || './mendfix-output';
    const args = [ENGINE_CLI_PATH, 'apply', '--report', reportPath];
    if (pkgPath)  args.push('--package-json', pkgPath);
    if (lockPath) args.push('--lock-file', lockPath);
    args.push('--out-dir', resolvedOutDir);
    if (ecosystem && ecosystem !== 'auto') args.push('--ecosystem', ecosystem);
    if (applyPhaseB)    args.push('--apply-phase-b');
    if (dryRun)         args.push('--dry-run');
    if (verifyVersions) args.push('--verify-versions');

    this._view.webview.postMessage({ type: 'applyStart', dryRun: !!dryRun });

    const proc = spawn(process.execPath, args, {
      cwd: path.dirname(pkgPath || reportPath),
    });

    const send = (line) =>
      this._view.webview.postMessage({ type: 'applyProgress', line: line.trimEnd() });

    const startMs = Date.now();
    proc.stdout.on('data', (chunk) =>
      chunk.toString().split('\n').filter(Boolean).forEach(send));
    proc.stderr.on('data', (chunk) =>
      chunk.toString().split('\n').filter(Boolean).forEach(l => send('⚠ ' + l)));

    proc.on('close', (code) => {
      const elapsedMs = Date.now() - startMs;

      // Attempt to read graph-diff.md produced by apply
      let graphDiff = null;
      const graphDiffPath = path.join(path.isAbsolute(resolvedOutDir) ? resolvedOutDir : path.join(path.dirname(pkgPath || reportPath), resolvedOutDir), 'graph-diff.md');
      if (fs.existsSync(graphDiffPath)) {
        try { graphDiff = fs.readFileSync(graphDiffPath, 'utf8'); } catch (_) {}
      }

      this._view.webview.postMessage({
        type:      'applyDone',
        success:   code === 0,
        exitCode:  code,
        outDir:    resolvedOutDir,
        elapsedMs,
        graphDiff,
      });
    });

    proc.on('error', (err) => {
      this._view.webview.postMessage({ type: 'applyError', message: err.message });
    });
  }

  // ---------------------------------------------------------------------------
  // Export — Panel 4 (SARIF / VEX / KPI)
  // ---------------------------------------------------------------------------

  async _handleExport(msg) {
    const { format } = msg;
    if (!this._lastAnalysis) {
      this._view.webview.postMessage({ type: 'exportError', message: 'Run Analyze first.' });
      return;
    }

    try {
      const { phasedPlan } = this._lastAnalysis;
      const { createEvidence } = require(EVIDENCE_MODEL_PATH);
      const bundles = phasedPlan.map(item => {
        try { return createEvidence(item, {}); } catch (_) { return null; }
      }).filter(Boolean);

      const resolvedOutDir = this._outDir || './mendfix-output';
      const outDirAbs = path.isAbsolute(resolvedOutDir) ? resolvedOutDir : path.join(process.cwd(), resolvedOutDir);
      if (!fs.existsSync(outDirAbs)) fs.mkdirSync(outDirAbs, { recursive: true });

      let filePath;
      if (format === 'sarif') {
        const { toSarif } = require(EVIDENCE_MODEL_PATH);
        const sarif = toSarif(bundles, { tool: 'mend-autofixer' });
        filePath = path.join(outDirAbs, 'remediation-evidence.sarif');
        fs.writeFileSync(filePath, JSON.stringify(sarif, null, 2));
      } else if (format === 'vex') {
        const { toCycloneDxVex } = require(EVIDENCE_MODEL_PATH);
        const vex = toCycloneDxVex(bundles, { tool: 'mend-autofixer' });
        filePath = path.join(outDirAbs, 'remediation.vex.json');
        fs.writeFileSync(filePath, JSON.stringify(vex, null, 2));
      } else if (format === 'kpi') {
        const { generateKPIReport } = require(KPI_REPORT_PATH);
        const report = generateKPIReport(bundles);
        filePath = path.join(outDirAbs, 'kpi-report.md');
        fs.writeFileSync(filePath, report);
      }

      if (filePath) {
        vscode.workspace.openTextDocument(filePath).then(doc =>
          vscode.window.showTextDocument(doc)
        ).catch(() => {});
        this._view.webview.postMessage({ type: 'exportDone', format, filePath });
      }
    } catch (err) {
      this._view.webview.postMessage({ type: 'exportError', message: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Rollback — Panel 3 (runs mendfix cleanup)
  // ---------------------------------------------------------------------------

  async _handleRollback(msg) {
    const { pkgPath, lockPath } = msg;
    const args = [ENGINE_CLI_PATH, 'cleanup'];
    if (pkgPath)  args.push('--package-json', pkgPath);
    if (lockPath) args.push('--lock-file', lockPath);

    this._view.webview.postMessage({ type: 'rollbackStart' });

    const proc = spawn(process.execPath, args, {
      cwd: path.dirname(pkgPath || lockPath || process.cwd()),
    });
    proc.on('close', (code) =>
      this._view.webview.postMessage({ type: 'rollbackDone', success: code === 0, exitCode: code })
    );
    proc.on('error', (err) =>
      this._view.webview.postMessage({ type: 'rollbackError', message: err.message })
    );
  }

  // ---------------------------------------------------------------------------
  // Load demo output — triggered by extension command / demo --ui
  // ---------------------------------------------------------------------------

  async _handleLoadDemo(msg) {
    const demoPath = (msg && msg.demoPath) || path.join(process.cwd(), 'demo-output', 'demo-analysis.json');
    if (!fs.existsSync(demoPath)) {
      this._view.webview.postMessage({ type: 'error', message: 'Demo output not found at ' + demoPath + '. Run `mendfix demo` first.' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
      await this._dispatchAnalysisResult(
        raw.phasedPlan || [],
        raw.entries    || [],
        raw.provider   || 'mend',
        raw.exposureResults || []
      );
    } catch (e) {
      this._view.webview.postMessage({ type: 'error', message: 'Failed to load demo: ' + e.message });
    }
  }

  // ---------------------------------------------------------------------------
  // HTML — 4-panel thin client
  // ---------------------------------------------------------------------------

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>MendFix</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  margin: 0;
  padding: 0;
}

/* ── Tab bar ─────────────────────────────────────────────────── */
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  background: var(--vscode-sideBar-background, transparent);
  padding: 0 8px;
  gap: 0;
  flex-shrink: 0;
}
.tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 10px;
  font-size: 0.82em;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  white-space: nowrap;
  margin-bottom: -1px;
}
.tab-btn:hover { color: var(--vscode-foreground); }
.tab-btn.active {
  color: var(--vscode-foreground);
  border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
}
.tab-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Tab panels ──────────────────────────────────────────────── */
.panels { padding: 10px 12px; overflow-y: auto; }
.panel  { display: none; }
.panel.active { display: block; }

/* ── Common controls ─────────────────────────────────────────── */
.section { margin-bottom: 10px; }
.label {
  font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.file-row { display: flex; gap: 6px; align-items: center; }
.file-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.85em;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px; padding: 3px 6px; min-width: 0;
}
button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none; border-radius: 2px;
  padding: 4px 10px; font-size: 0.85em; cursor: pointer; white-space: nowrap;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.danger {
  background: rgba(200,40,40,0.15);
  color: var(--vscode-editorError-foreground, #f85149);
  border: 1px solid rgba(200,40,40,0.3);
}
button.danger:hover { background: rgba(200,40,40,0.25); }
.primary-btn { width: 100%; padding: 6px; font-size: 0.9em; margin-top: 2px; margin-bottom: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 0.85em; cursor: pointer; }

/* ── Status / spinner ─────────────────────────────────────────── */
.status {
  display: flex; align-items: center; gap: 8px; font-size: 0.85em;
  padding: 8px; border-radius: 3px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  margin-bottom: 10px;
}
.status.error {
  background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
  border-left: 3px solid var(--vscode-editorError-foreground, #f44);
}
.status.error .status-msg { color: var(--vscode-editorError-foreground, #f44); }
@keyframes spin { to { transform: rotate(360deg); } }
.spinner {
  flex-shrink: 0; width: 13px; height: 13px;
  border: 2px solid var(--vscode-foreground); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}

/* ── Phase cards ─────────────────────────────────────────────── */
.phase-cards { display: flex; gap: 6px; margin-bottom: 10px; }
.phase-card  { flex: 1; border-radius: 4px; padding: 7px 4px; text-align: center; border: 1px solid transparent; }
.phase-a { background: rgba(35,134,54,0.15); border-color: rgba(35,134,54,0.4); color: var(--vscode-testing-iconPassed, #3fb950); }
.phase-b { background: rgba(210,153,34,0.15); border-color: rgba(210,153,34,0.4); color: var(--vscode-editorWarning-foreground, #d29922); }
.phase-c { background: rgba(248,81,73,0.15); border-color: rgba(248,81,73,0.4); color: var(--vscode-editorError-foreground, #f85149); }
.phase-count { font-size: 1.4em; font-weight: 700; line-height: 1.2; }
.phase-label { font-size: 0.78em; font-weight: 600; }
.phase-cves  { font-size: 0.7em; opacity: 0.75; }

/* ── Summary row ─────────────────────────────────────────────── */
.summary-row { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.summary-row strong { color: var(--vscode-foreground); }
.scanner-badge {
  display: inline-block; font-size: 0.78em; padding: 1px 7px;
  border-radius: 10px; border: 1px solid var(--vscode-focusBorder, rgba(128,128,128,0.4));
  color: var(--vscode-descriptionForeground); margin-left: 4px;
}

/* ── Comparison box ──────────────────────────────────────────── */
.comparison-box {
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
  border-radius: 4px; padding: 8px; margin-bottom: 10px; font-size: 0.83em;
}
.comparison-box h4 { margin: 0 0 6px; font-size: 0.85em; color: var(--vscode-descriptionForeground); font-weight: 600; }
.comp-row { display: flex; justify-content: space-between; padding: 2px 0; }
.comp-label { color: var(--vscode-descriptionForeground); }
.comp-val   { font-weight: 600; color: var(--vscode-foreground); }
.comp-val.green { color: var(--vscode-testing-iconPassed, #3fb950); }
.comp-val.amber { color: var(--vscode-editorWarning-foreground, #d29922); }
.comp-val.red   { color: var(--vscode-editorError-foreground, #f85149); }

/* ── Exposure row ────────────────────────────────────────────── */
.exposure-row { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.exp-chip {
  padding: 1px 7px; border-radius: 10px; border: 1px solid;
  font-size: 0.9em; font-weight: 600;
}
.exp-runtime { border-color: rgba(248,81,73,0.4); color: var(--vscode-editorError-foreground, #f85149); background: rgba(248,81,73,0.08); }
.exp-test    { border-color: rgba(35,134,54,0.4);  color: var(--vscode-testing-iconPassed, #3fb950); background: rgba(35,134,54,0.08); }
.exp-build   { border-color: rgba(210,153,34,0.4); color: var(--vscode-editorWarning-foreground, #d29922); background: rgba(210,153,34,0.08); }
.exp-unknown { border-color: rgba(128,128,128,0.3); color: var(--vscode-descriptionForeground); background: rgba(128,128,128,0.08); }

/* ── Library list ────────────────────────────────────────────── */
.lib-section { margin-bottom: 8px; }
.lib-section-title { font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.lib-item { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: baseline; padding: 3px 6px; border-radius: 3px; font-size: 0.83em; margin-bottom: 2px; }
.lib-item:hover { background: var(--vscode-list-hoverBackground); }
.lib-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-version { font-size: 0.8em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.sev-badge { font-size: 0.7em; padding: 1px 5px; border-radius: 10px; font-weight: 600; text-transform: uppercase; }
.sev-critical { background: rgba(188,0,0,0.3); color: #ff6b6b; }
.sev-high     { background: rgba(210,100,0,0.25); color: var(--vscode-editorError-foreground, #f85149); }
.sev-medium   { background: rgba(210,153,34,0.25); color: var(--vscode-editorWarning-foreground, #d29922); }
.sev-low      { background: rgba(100,180,100,0.2); color: var(--vscode-testing-iconPassed, #3fb950); }
.sev-unknown  { background: rgba(128,128,128,0.2); color: var(--vscode-descriptionForeground); }

/* ── Action button row ───────────────────────────────────────── */
.action-bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.action-bar button { font-size: 0.83em; padding: 5px 10px; }

/* ── Apply confirmation ──────────────────────────────────────── */
.confirm-box {
  border: 1px solid var(--vscode-focusBorder, rgba(128,128,128,0.3));
  border-radius: 4px; padding: 10px; margin-bottom: 10px; font-size: 0.85em;
}
.confirm-title { font-weight: 600; margin-bottom: 6px; }
.confirm-meta  { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 8px; }
.confirm-btns  { display: flex; gap: 8px; }
.confirm-btns button { flex: 1; padding: 5px 8px; font-size: 0.88em; }

/* ── Apply log ───────────────────────────────────────────────── */
.apply-log {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.78em;
  background: var(--vscode-terminal-background, var(--vscode-editor-background));
  color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground));
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  border-radius: 3px; padding: 6px 8px;
  max-height: 180px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all; margin-bottom: 6px;
}
.apply-log .log-ok   { color: var(--vscode-testing-iconPassed, #3fb950); }
.apply-log .log-warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.apply-log .log-err  { color: var(--vscode-editorError-foreground, #f85149); }
.apply-result { font-size: 0.85em; padding: 6px 8px; border-radius: 3px; margin-bottom: 6px; }
.apply-result.success { background: rgba(35,134,54,0.15); border-left: 3px solid var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-testing-iconPassed, #3fb950); }
.apply-result.failure { background: rgba(248,81,73,0.12); border-left: 3px solid var(--vscode-editorError-foreground, #f85149); color: var(--vscode-editorError-foreground, #f85149); }

/* ── Graph diff ──────────────────────────────────────────────── */
.graph-diff {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.78em;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  border-radius: 3px; padding: 6px 8px;
  max-height: 150px; overflow-y: auto;
  white-space: pre-wrap; margin-bottom: 8px;
}
.diff-section-title { font-size: 0.78em; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.05em; }

/* ── Evidence items ──────────────────────────────────────────── */
.evidence-item {
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 0.83em;
}
.ev-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.ev-name   { font-weight: 600; }
.ev-badges { display: flex; gap: 4px; }
.ev-body   { color: var(--vscode-descriptionForeground); font-size: 0.9em; line-height: 1.4; }
.ev-body strong { color: var(--vscode-foreground); }

/* ── Export bar ──────────────────────────────────────────────── */
.export-bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.export-bar button { font-size: 0.82em; padding: 5px 10px; }
.export-result { font-size: 0.82em; padding: 4px 8px; border-radius: 3px; margin-bottom: 6px; }
.export-result.ok  { background: rgba(35,134,54,0.12); color: var(--vscode-testing-iconPassed, #3fb950); }
.export-result.err { background: rgba(248,81,73,0.1); color: var(--vscode-editorError-foreground, #f85149); }

/* ── Divider / empty state ───────────────────────────────────── */
.divider { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); margin: 10px 0; }
.empty-state { text-align: center; color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 20px 0; }
.settings-link { font-size: 0.78em; color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; display: block; margin-top: 8px; text-align: right; }
.settings-link:hover { text-decoration: underline; }

select {
  width: 100%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px;
  padding: 3px 6px; font-size: 0.85em; font-family: inherit;
}

.hidden { display: none !important; }
</style>
</head>
<body>

<!-- ── Tab bar ─────────────────────────────────────────────── -->
<div class="tab-bar">
  <button class="tab-btn active" id="tabScanBtn"     onclick="switchTab('scan')">Scan</button>
  <button class="tab-btn"        id="tabAnalyzeBtn"  onclick="switchTab('analyze')" disabled>Analyze</button>
  <button class="tab-btn"        id="tabApplyBtn"    onclick="switchTab('apply')"   disabled>Apply</button>
  <button class="tab-btn"        id="tabEvidenceBtn" onclick="switchTab('evidence')" disabled>Evidence</button>
</div>

<!-- ── Panels ─────────────────────────────────────────────── -->
<div class="panels">

  <!-- ══ PANEL 1: SCAN ═══════════════════════════════════════ -->
  <div class="panel active" id="panel-scan">
    <div class="section">
      <div class="label">Vulnerability report</div>
      <div class="file-row">
        <span id="fileName" class="file-name">No file selected</span>
        <button id="browseBtn" class="secondary">Browse</button>
      </div>
    </div>

    <div id="scannerBadge" class="hidden summary-row" style="margin-bottom:6px"></div>

    <div class="section">
      <label class="checkbox-label">
        <input type="checkbox" id="verifyVersions"> Verify registry versions
      </label>
    </div>

    <!-- Repo target (collapsible) -->
    <div id="repoToggle" style="font-size:0.82em;color:var(--vscode-descriptionForeground);cursor:pointer;margin-bottom:6px;user-select:none" onclick="toggleRepo()">
      <span id="repoChevron">&#9654;</span> Repo target (optional)
    </div>
    <div id="repoBody" class="hidden">
      <div class="section">
        <div class="label">package.json</div>
        <div class="file-row">
          <span id="pkgName" class="file-name">Not set</span>
          <button id="browsePkgBtn" class="secondary">Browse</button>
        </div>
      </div>
      <div class="section">
        <div class="label">package-lock.json</div>
        <div class="file-row">
          <span id="lockName" class="file-name">Not set</span>
          <button id="browseLockBtn" class="secondary">Browse</button>
        </div>
      </div>
      <div class="section">
        <div class="label">Ecosystem</div>
        <select id="ecosystem">
          <option value="auto">Auto-detect</option>
          <option value="npm">npm</option>
          <option value="maven">Maven</option>
          <option value="python">Python</option>
          <option value="go">Go</option>
          <option value="dotnet">.NET</option>
          <option value="rust">Rust</option>
        </select>
      </div>
    </div>

    <button id="analyzeBtn" class="primary-btn" disabled>Analyze</button>

    <!-- Library list (shown after analyze) -->
    <div id="scanResults" class="hidden">
      <div class="summary-row" id="scanSummary"></div>
      <div id="scanLibList"></div>
    </div>

    <!-- Status / error -->
    <div id="statusEl" class="status hidden">
      <span class="spinner"></span>
      <span class="status-msg">Analyzing…</span>
    </div>

    <a class="settings-link" id="settingsLink">&#9881; MendFix settings</a>
    <button class="secondary" id="loadDemoBtn" style="width:100%;margin-top:6px;font-size:0.8em">Load Demo Output</button>
  </div>

  <!-- ══ PANEL 2: ANALYZE ════════════════════════════════════ -->
  <div class="panel" id="panel-analyze">
    <div class="summary-row" id="analyzeSummary"></div>

    <!-- Phase cards -->
    <div class="phase-cards">
      <div class="phase-card phase-a">
        <div class="phase-count" id="phaseACount">0</div>
        <div class="phase-label">Phase A</div>
        <div class="phase-cves"  id="phaseACves"></div>
        <div style="font-size:0.68em;opacity:0.7">Auto-apply</div>
      </div>
      <div class="phase-card phase-b">
        <div class="phase-count" id="phaseBCount">0</div>
        <div class="phase-label">Phase B</div>
        <div class="phase-cves"  id="phaseBCves"></div>
        <div style="font-size:0.68em;opacity:0.7">Review first</div>
      </div>
      <div class="phase-card phase-c">
        <div class="phase-count" id="phaseCCount">0</div>
        <div class="phase-label">Phase C</div>
        <div class="phase-cves"  id="phaseCCves"></div>
        <div style="font-size:0.68em;opacity:0.7">Manual review</div>
      </div>
    </div>

    <!-- Exposure summary -->
    <div id="exposureRow" class="exposure-row hidden"></div>

    <!-- Comparison box -->
    <div id="comparisonBox" class="comparison-box hidden">
      <h4>vs. Scanner baseline</h4>
      <div id="comparisonRows"></div>
    </div>

    <!-- Action buttons -->
    <div class="action-bar">
      <button id="goApplyBtn">Apply Phase A</button>
      <button class="secondary" id="goEvidenceBtn">View Evidence</button>
    </div>
    <div class="action-bar">
      <button class="secondary" id="exportSarifBtn">Export SARIF</button>
      <button class="secondary" id="exportVexBtn">Export VEX</button>
      <button class="secondary" id="exportKpiBtn">KPI Report</button>
    </div>
    <div id="analyzeExportResult" class="export-result hidden"></div>

    <!-- Finding detail list -->
    <div id="analyzeLibList"></div>
  </div>

  <!-- ══ PANEL 3: APPLY ══════════════════════════════════════ -->
  <div class="panel" id="panel-apply">

    <!-- Confirmation gate -->
    <div id="confirmBox" class="confirm-box">
      <div class="confirm-title" id="confirmTitle">Apply Phase A fixes?</div>
      <div class="confirm-meta"  id="confirmMeta"></div>
      <div class="section">
        <label class="checkbox-label">
          <input type="checkbox" id="applyPhaseB"> Also apply Phase B (review first)
        </label>
      </div>
      <div class="section">
        <label class="checkbox-label">
          <input type="checkbox" id="dryRun"> Dry run (no writes)
        </label>
      </div>
      <div class="confirm-btns">
        <button id="confirmApplyBtn">Confirm &amp; Apply</button>
        <button class="secondary" id="cancelApplyBtn">Cancel</button>
      </div>
    </div>

    <!-- Apply log -->
    <div id="applyLogEl" class="apply-log hidden"></div>
    <div id="applyResultEl" class="apply-result hidden"></div>

    <!-- Graph diff (after apply) -->
    <div id="graphDiffSection" class="hidden">
      <div class="diff-section-title">Dependency graph changes</div>
      <div id="graphDiffContent" class="graph-diff"></div>
    </div>

    <!-- Rollback button (after apply) -->
    <div id="rollbackBar" class="hidden action-bar">
      <button class="danger" id="rollbackBtn">Rollback</button>
      <div id="rollbackStatus" style="font-size:0.82em;align-self:center;color:var(--vscode-descriptionForeground)"></div>
    </div>
  </div>

  <!-- ══ PANEL 4: EVIDENCE ════════════════════════════════════ -->
  <div class="panel" id="panel-evidence">

    <!-- Export buttons -->
    <div class="export-bar">
      <button class="secondary" id="ev-sarifBtn">Download SARIF</button>
      <button class="secondary" id="ev-vexBtn">Download VEX</button>
      <button class="secondary" id="ev-kpiBtn">KPI Report</button>
    </div>
    <div id="evidenceExportResult" class="export-result hidden"></div>

    <hr class="divider">

    <!-- Evidence items list -->
    <div id="evidenceList">
      <div class="empty-state">Run Analyze to populate evidence.</div>
    </div>
  </div>

</div><!-- /panels -->

<script>
const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────
let selectedPath = '';
let pkgPath  = '';
let lockPath = '';
let outDir   = '';
let lastPhaseACount = 0;
let lastPhaseACves  = 0;
let applyInFlight   = false;

// ── Tab switching ─────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.getElementById('tab' + id.charAt(0).toUpperCase() + id.slice(1) + 'Btn').classList.add('active');
}

function enableTabs(...ids) {
  ids.forEach(id => {
    const btn = document.getElementById('tab' + id.charAt(0).toUpperCase() + id.slice(1) + 'Btn');
    if (btn) btn.disabled = false;
  });
}

// ── Repo target toggle ────────────────────────────────────────
function toggleRepo() {
  const body = document.getElementById('repoBody');
  const ch   = document.getElementById('repoChevron');
  if (body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    ch.innerHTML = '&#9660;';
  } else {
    body.classList.add('hidden');
    ch.innerHTML = '&#9654;';
  }
}

// ── Buttons ───────────────────────────────────────────────────
document.getElementById('browseBtn').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
document.getElementById('browsePkgBtn').addEventListener('click', () => vscode.postMessage({ type: 'browsePkg' }));
document.getElementById('browseLockBtn').addEventListener('click', () => vscode.postMessage({ type: 'browseLock' }));
document.getElementById('settingsLink').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
document.getElementById('loadDemoBtn').addEventListener('click', () => vscode.postMessage({ type: 'loadDemo' }));

document.getElementById('analyzeBtn').addEventListener('click', () => {
  if (!selectedPath) return;
  vscode.postMessage({
    type: 'analyze',
    reportPath:     selectedPath,
    verifyVersions: document.getElementById('verifyVersions').checked,
    lockPath:       lockPath || null,
  });
});

// Analyze panel → Apply
document.getElementById('goApplyBtn').addEventListener('click', () => {
  switchTab('apply');
  document.getElementById('confirmBox').classList.remove('hidden');
  hide(document.getElementById('applyLogEl'));
  hide(document.getElementById('applyResultEl'));
  hide(document.getElementById('graphDiffSection'));
  hide(document.getElementById('rollbackBar'));
});
document.getElementById('goEvidenceBtn').addEventListener('click', () => switchTab('evidence'));

// Export buttons (Analyze panel)
document.getElementById('exportSarifBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'sarif', outDir }));
document.getElementById('exportVexBtn').addEventListener('click',  () => vscode.postMessage({ type: 'export', format: 'vex',   outDir }));
document.getElementById('exportKpiBtn').addEventListener('click',  () => vscode.postMessage({ type: 'export', format: 'kpi',   outDir }));

// Export buttons (Evidence panel)
document.getElementById('ev-sarifBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'sarif', outDir }));
document.getElementById('ev-vexBtn').addEventListener('click',   () => vscode.postMessage({ type: 'export', format: 'vex',   outDir }));
document.getElementById('ev-kpiBtn').addEventListener('click',   () => vscode.postMessage({ type: 'export', format: 'kpi',   outDir }));

// Apply confirmation
document.getElementById('confirmApplyBtn').addEventListener('click', () => {
  if (!selectedPath || applyInFlight) return;
  applyInFlight = true;
  document.getElementById('confirmApplyBtn').disabled = true;
  vscode.postMessage({
    type:           'apply',
    reportPath:     selectedPath,
    pkgPath,
    lockPath,
    ecosystem:      document.getElementById('ecosystem').value,
    applyPhaseB:    document.getElementById('applyPhaseB').checked,
    dryRun:         document.getElementById('dryRun').checked,
    verifyVersions: document.getElementById('verifyVersions').checked,
    outDir,
  });
});
document.getElementById('cancelApplyBtn').addEventListener('click', () => switchTab('analyze'));

// Rollback
document.getElementById('rollbackBtn').addEventListener('click', () => {
  if (!pkgPath && !lockPath) {
    document.getElementById('rollbackStatus').textContent = 'Set package.json or lock file first.';
    return;
  }
  vscode.postMessage({ type: 'rollback', pkgPath, lockPath });
});

// ── Message handlers ─────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    applyInit(msg.settings);
    return;
  }

  if (msg.type === 'filePicked') {
    setFile(msg.path);
    return;
  }

  if (msg.type === 'fieldPicked') {
    setField(msg.field, msg.path);
    return;
  }

  if (msg.type === 'thinking') {
    document.getElementById('analyzeBtn').disabled = true;
    const s = document.getElementById('statusEl');
    s.className = 'status';
    s.innerHTML = '<span class="spinner"></span><span class="status-msg">Analyzing…</span>';
    show(s);
    hide(document.getElementById('scanResults'));
    return;
  }

  if (msg.type === 'result') {
    renderResult(msg.data);
    return;
  }

  if (msg.type === 'error') {
    document.getElementById('analyzeBtn').disabled = !!selectedPath ? false : true;
    const s = document.getElementById('statusEl');
    s.className = 'status error';
    const hint = msg.errorKind === 'notfound' ? 'File not found or unsupported format.' : (msg.message || 'Unknown error.');
    s.innerHTML = '<span class="status-msg">⚠ ' + escHtml(hint) + '</span>';
    show(s);
    return;
  }

  if (msg.type === 'applyStart') {
    document.getElementById('confirmBox').classList.add('hidden');
    const log = document.getElementById('applyLogEl');
    log.innerHTML = '';
    show(log);
    hide(document.getElementById('applyResultEl'));
    appendLog(msg.dryRun ? 'Dry-run — no writes to disk…' : 'Applying fixes…', 'log-ok');
    return;
  }

  if (msg.type === 'applyProgress') {
    const line = msg.line || '';
    const cls  = line.startsWith('⚠') ? 'log-warn' : /error|fail/i.test(line) ? 'log-err' : '';
    appendLog(line, cls);
    return;
  }

  if (msg.type === 'applyDone') {
    applyInFlight = false;
    document.getElementById('confirmApplyBtn').disabled = false;
    const resultEl = document.getElementById('applyResultEl');
    resultEl.className = 'apply-result ' + (msg.success ? 'success' : 'failure');
    const elapsed = msg.elapsedMs ? ' (' + (msg.elapsedMs / 1000).toFixed(1) + 's)' : '';
    resultEl.textContent = msg.success
      ? '✓ Fixes applied' + elapsed + '. Output: ' + (msg.outDir || './mendfix-output')
      : '✗ Apply exited with code ' + msg.exitCode + '. See log above.';
    show(resultEl);

    if (msg.graphDiff) {
      document.getElementById('graphDiffContent').textContent = msg.graphDiff;
      show(document.getElementById('graphDiffSection'));
    }
    if (msg.success) {
      show(document.getElementById('rollbackBar'));
    }
    return;
  }

  if (msg.type === 'applyError') {
    applyInFlight = false;
    document.getElementById('confirmApplyBtn').disabled = false;
    appendLog('⚠ ' + (msg.message || 'Apply failed'), 'log-err');
    const resultEl = document.getElementById('applyResultEl');
    resultEl.className = 'apply-result failure';
    resultEl.textContent = '✗ ' + (msg.message || 'Apply failed');
    show(resultEl);
    return;
  }

  if (msg.type === 'exportDone') {
    showExportResult('ok', '✓ ' + msg.format.toUpperCase() + ' exported to ' + msg.filePath);
    return;
  }

  if (msg.type === 'exportError') {
    showExportResult('err', '⚠ Export failed: ' + (msg.message || 'Unknown error'));
    return;
  }

  if (msg.type === 'rollbackStart') {
    document.getElementById('rollbackStatus').textContent = 'Rolling back…';
    document.getElementById('rollbackBtn').disabled = true;
    return;
  }

  if (msg.type === 'rollbackDone') {
    document.getElementById('rollbackBtn').disabled = false;
    document.getElementById('rollbackStatus').textContent = msg.success ? '✓ Rollback complete.' : '✗ Rollback exited ' + msg.exitCode;
    return;
  }

  if (msg.type === 'rollbackError') {
    document.getElementById('rollbackBtn').disabled = false;
    document.getElementById('rollbackStatus').textContent = '⚠ ' + msg.message;
    return;
  }
});

// ── Render helpers ────────────────────────────────────────────

function renderResult(d) {
  document.getElementById('analyzeBtn').disabled = false;
  hide(document.getElementById('statusEl'));

  // Scan tab — summary + raw list
  const scanSummary = document.getElementById('scanSummary');
  scanSummary.innerHTML =
    '<strong>' + d.totalLibraries + '</strong> libraries &middot; ' +
    '<strong>' + d.totalCVEs + '</strong> CVEs' +
    '<span class="scanner-badge">' + escHtml(d.scanner || 'Unknown') + '</span>';
  document.getElementById('scanLibList').innerHTML =
    renderLibSection('All findings', d.libraryRows || []);
  show(document.getElementById('scanResults'));

  // Scanner badge
  const badge = document.getElementById('scannerBadge');
  badge.innerHTML = 'Detected: <strong>' + escHtml(d.scanner || 'Unknown') + '</strong>';
  show(badge);

  // Analyze tab
  document.getElementById('analyzeSummary').innerHTML =
    '<strong>' + d.totalLibraries + '</strong> libraries &middot; ' +
    '<strong>' + d.totalCVEs + '</strong> CVEs &middot; <span class="scanner-badge">' + escHtml(d.scanner) + '</span>';
  document.getElementById('phaseACount').textContent = d.phaseA.length;
  document.getElementById('phaseBCount').textContent = d.phaseB.length;
  document.getElementById('phaseCCount').textContent = d.phaseC.length;
  document.getElementById('phaseACves').textContent  = d.phaseACveCount > 0 ? d.phaseACveCount + ' CVEs' : '';
  document.getElementById('phaseBCves').textContent  = d.phaseBCveCount > 0 ? d.phaseBCveCount + ' CVEs' : '';
  document.getElementById('phaseCCves').textContent  = d.phaseCCveCount > 0 ? d.phaseCCveCount + ' CVEs' : '';

  // Exposure chips
  if (d.exposureSummary) {
    renderExposure(d.exposureSummary);
  }

  // Comparison box
  if (d.comparison) {
    renderComparison(d.comparison);
  }

  // Analyze lib list
  document.getElementById('analyzeLibList').innerHTML =
    renderLibSection('✅ Phase A — Auto-apply',   d.phaseA) +
    renderLibSection('⚠️ Phase B — Review first',   d.phaseB) +
    renderLibSection('❌ Phase C — Manual review', d.phaseC);

  // Apply tab — confirmation meta
  lastPhaseACount = d.phaseA.length;
  lastPhaseACves  = d.phaseACveCount || 0;
  document.getElementById('confirmTitle').textContent = 'Apply ' + d.phaseA.length + ' Phase A fix' + (d.phaseA.length !== 1 ? 'es' : '') + '?';
  document.getElementById('confirmMeta').textContent  =
    'Closes ' + lastPhaseACves + ' CVE' + (lastPhaseACves !== 1 ? 's' : '') + ' automatically.';

  // Evidence tab
  if (d.evidenceItems && d.evidenceItems.length) {
    renderEvidenceItems(d.evidenceItems);
  }

  // Enable tabs and switch to Analyze
  enableTabs('analyze', 'apply', 'evidence');
  switchTab('analyze');
}

function renderExposure(s) {
  const chips = [];
  if (s.runtimeReachable) chips.push('<span class="exp-chip exp-runtime">' + s.runtimeReachable + ' Runtime</span>');
  if (s.testOnly)         chips.push('<span class="exp-chip exp-test">'    + s.testOnly + ' Test-only</span>');
  if (s.buildTime)        chips.push('<span class="exp-chip exp-build">'   + s.buildTime + ' Build-time</span>');
  if (s.ciOnly)           chips.push('<span class="exp-chip exp-build">'   + s.ciOnly + ' CI-only</span>');
  if (s.unknown)          chips.push('<span class="exp-chip exp-unknown">' + s.unknown + ' Unknown</span>');
  const row = document.getElementById('exposureRow');
  if (chips.length) {
    row.innerHTML = chips.join('');
    show(row);
  }
}

function renderComparison(c) {
  const box = document.getElementById('comparisonBox');
  const rows = document.getElementById('comparisonRows');
  rows.innerHTML =
    compRow('Scanner input', c.scannerTotal + ' CVEs', '') +
    compRow('Auto-closeable (A+B)', c.engineAutoClose, 'green') +
    compRow('Requires action (C)', c.engineRequiresAction, 'amber') +
    (c.engineNotProdReachable > 0 ? compRow('Not prod-reachable', c.engineNotProdReachable, 'green') : '');
  show(box);
}

function compRow(label, val, cls) {
  return '<div class="comp-row"><span class="comp-label">' + escHtml(String(label)) + '</span>' +
    '<span class="comp-val' + (cls ? ' ' + cls : '') + '">' + escHtml(String(val)) + '</span></div>';
}

function renderLibSection(title, items) {
  if (!items || !items.length) return '';
  const rows = items.map(lib => {
    const ver = lib.recommended && lib.recommended !== '—'
      ? lib.current + ' → ' + lib.recommended
      : lib.current;
    const badge = '<span class="sev-badge ' + sevClass(lib.highestSeverity) + '">' + (lib.highestSeverity || '?') + '</span>';
    const cves  = lib.cveCount ? lib.cveCount + ' CVE' + (lib.cveCount > 1 ? 's' : '') : '';
    return '<div class="lib-item">' +
      '<div><div class="lib-name">' + escHtml(lib.name) + '</div>' +
      '<div class="lib-version">' + escHtml(ver) + (cves ? ' &middot; ' + cves : '') + '</div></div>' +
      badge + '</div>';
  }).join('');
  return '<div class="lib-section"><div class="lib-section-title">' + title + '</div>' + rows + '</div>';
}

function renderEvidenceItems(items) {
  const container = document.getElementById('evidenceList');
  container.innerHTML = items.map(item => {
    const phaseCls = item.phase === 'A' ? 'phase-a' : item.phase === 'B' ? 'phase-b' : 'phase-c';
    const expBadge = item.exposure !== 'UNKNOWN'
      ? '<span class="sev-badge ' + expClass(item.exposure) + '">' + escHtml(item.exposure.replace(/_/g,' ')) + '</span>'
      : '';
    const jText = item.justification || item.evidence || '';
    return '<div class="evidence-item">' +
      '<div class="ev-header">' +
        '<span class="ev-name">' + escHtml(item.name) + '</span>' +
        '<div class="ev-badges">' +
          '<span class="sev-badge ' + phaseCls + '">Phase ' + item.phase + '</span>' +
          '<span class="sev-badge ' + sevClass(item.highestSeverity) + '">' + (item.highestSeverity || '?') + '</span>' +
          expBadge +
        '</div>' +
      '</div>' +
      '<div class="ev-body">' +
        '<strong>' + escHtml(item.current || '') + '</strong>' +
        (item.recommended && item.recommended !== '—' ? ' → ' + escHtml(item.recommended) : '') +
        (item.cves ? ' &middot; ' + escHtml(item.cves) : '') +
        (jText ? '<br><span style="opacity:0.8">' + escHtml(jText.substring(0,120)) + (jText.length > 120 ? '…' : '') + '</span>' : '') +
      '</div>' +
      '</div>';
  }).join('');
}

function expClass(exp) {
  if (exp === 'RUNTIME_REACHABLE') return 'sev-high';
  if (exp === 'TEST_ONLY' || exp === 'LOCAL_TOOLING_ONLY') return 'sev-low';
  if (exp === 'BUILD_TIME_EXECUTED' || exp === 'CI_EXECUTED') return 'sev-medium';
  return 'sev-unknown';
}

function showExportResult(cls, msg) {
  const active = document.getElementById('panel-analyze').classList.contains('active');
  const elId = active ? 'analyzeExportResult' : 'evidenceExportResult';
  const el = document.getElementById(elId);
  el.className = 'export-result ' + cls;
  el.textContent = msg;
  show(el);
  setTimeout(() => hide(el), 6000);
}

function setFile(fsPath) {
  selectedPath = fsPath;
  document.getElementById('fileName').textContent = fsPath.split(/[\\\\/]/).pop();
  document.getElementById('fileName').title = fsPath;
  document.getElementById('analyzeBtn').disabled = false;
  hide(document.getElementById('statusEl'));
  hide(document.getElementById('scanResults'));
  hide(document.getElementById('scannerBadge'));
}

function setField(field, fsPath) {
  if (field === 'packageJson') {
    pkgPath = fsPath;
    const el = document.getElementById('pkgName');
    el.textContent = fsPath.split(/[\\\\/]/).pop();
    el.title = fsPath;
  } else if (field === 'lockFile') {
    lockPath = fsPath;
    const el = document.getElementById('lockName');
    el.textContent = fsPath.split(/[\\\\/]/).pop();
    el.title = fsPath;
  }
}

function applyInit(s) {
  if (s.packageJson)  setField('packageJson', s.packageJson);
  if (s.lockFile)     setField('lockFile', s.lockFile);
  if (s.ecosystem)    document.getElementById('ecosystem').value = s.ecosystem;
  if (s.applyPhaseB)  document.getElementById('applyPhaseB').checked = s.applyPhaseB;
  if (s.dryRun)       document.getElementById('dryRun').checked = s.dryRun;
  if (s.verifyVersions) document.getElementById('verifyVersions').checked = s.verifyVersions;
  if (s.outDir)       outDir = s.outDir;
  if (s.packageJson || s.lockFile) {
    document.getElementById('repoBody').classList.remove('hidden');
    document.getElementById('repoChevron').innerHTML = '&#9660;';
  }
}

function appendLog(line, cls) {
  const el = document.getElementById('applyLogEl');
  if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line + '\\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function sevClass(sev) {
  const s = (sev || '').toLowerCase();
  if (s === 'critical') return 'sev-critical';
  if (s === 'high')     return 'sev-high';
  if (s === 'medium')   return 'sev-medium';
  if (s === 'low')      return 'sev-low';
  return 'sev-unknown';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

module.exports = { MendFixViewProvider };
