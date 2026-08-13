'use strict';

const vscode = require('vscode');
const path = require('path');

// Paths to core engine modules (relative to this extension file)
const PROVIDERS_PATH   = path.join(__dirname, '../../src/providers/index.js');
const SEMVER_PATH      = path.join(__dirname, '../../src/core/semver-engine.js');
const PHASES_PATH      = path.join(__dirname, '../../src/core/phases.js');

console.log(PROVIDERS_PATH, path, __dirname)

class MendFixViewProvider {
  static viewType = 'mendfix.panel';

  constructor(context) {
    this._context = context;
    this._view = undefined;
    this._pendingFile = undefined;
  }

  /** Called by VS Code when the sidebar panel first becomes visible. */
  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          // Webview finished loading — deliver any pending file from right-click
          if (this._pendingFile) {
            this._view.webview.postMessage({ type: 'filePicked', path: this._pendingFile });
            this._pendingFile = undefined;
          }
          break;
        case 'browse':
          await this._handleBrowse();
          break;
        case 'analyze':
          await this._handleAnalyze(msg.reportPath, msg.verifyVersions);
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'mendfix');
          break;
      }
    });
  }

  /** Called when user right-clicks a .json file → MendFix: Analyze Vulnerability Report */
  loadFile(fsPath) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'filePicked', path: fsPath });
    } else {
      this._pendingFile = fsPath;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
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

  async _handleAnalyze(reportPath, verifyVersions) {
    this._view.webview.postMessage({ type: 'thinking' });

    try {
      // Direct require of engine core — no child_process
      const { detectProvider, getParser } = require(PROVIDERS_PATH);
      const { buildResolutionPlan }        = require(SEMVER_PATH);
      const { applyPhases }                = require(PHASES_PATH);

      const provider = detectProvider(reportPath);
      const parser   = getParser(provider);
      const entries  = parser.parseReport(reportPath);
      const plan        = buildResolutionPlan(entries);
      const phasedItems = applyPhases(plan, null);

      const phaseA = phasedItems.filter(i => i.phase === 'A');
      const phaseB = phasedItems.filter(i => i.phase === 'B');
      const phaseC = phasedItems.filter(i => i.phase === 'C');
      const totalCVEs = phasedItems.reduce((s, i) => s + (i.cveCount || 0), 0);

      const toRow = (i) => ({
        name:            i.libraryName,
        current:         i.currentVersion,
        recommended:     i.recommendedVersion || '—',
        upgradeType:     i.upgradeType,
        cveCount:        i.cveCount || 0,
        highestSeverity: i.highestSeverity || 'UNKNOWN',
        phase:           i.phase,
      });

      this._view.webview.postMessage({
        type: 'result',
        data: {
          totalLibraries: phasedItems.length,
          totalCVEs,
          phaseA: phaseA.map(toRow),
          phaseB: phaseB.map(toRow),
          phaseC: phaseC.map(toRow),
        },
      });
    } catch (err) {
      const isNotFound = err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT';
      this._view.webview.postMessage({
        type: 'error',
        errorKind: isNotFound ? 'notfound' : 'unknown',
        message: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // HTML — full sidebar UI
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
      padding: 10px 12px;
    }

    /* ── File picker ─────────────────────────────────────────── */
    .section { margin-bottom: 10px; }

    .label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .file-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.88em;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 3px 6px;
      min-width: 0;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 4px 10px;
      font-size: 0.88em;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ── Checkbox ─────────────────────────────────────────────── */
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.88em;
      cursor: pointer;
      color: var(--vscode-foreground);
    }

    /* ── Primary action ───────────────────────────────────────── */
    .primary-btn {
      width: 100%;
      padding: 6px;
      font-size: 0.92em;
      margin-top: 2px;
      margin-bottom: 10px;
    }

    /* ── Status ───────────────────────────────────────────────── */
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.88em;
      padding: 8px;
      border-radius: 3px;
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
      flex-shrink: 0;
      width: 13px; height: 13px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    /* ── Results ──────────────────────────────────────────────── */
    .summary-row {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .summary-row strong { color: var(--vscode-foreground); }

    .phase-cards {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
    }
    .phase-card {
      flex: 1;
      border-radius: 4px;
      padding: 7px 4px;
      text-align: center;
      border: 1px solid transparent;
    }
    .phase-a {
      background: rgba(35, 134, 54, 0.15);
      border-color: rgba(35, 134, 54, 0.4);
      color: var(--vscode-testing-iconPassed, #3fb950);
    }
    .phase-b {
      background: rgba(210, 153, 34, 0.15);
      border-color: rgba(210, 153, 34, 0.4);
      color: var(--vscode-editorWarning-foreground, #d29922);
    }
    .phase-c {
      background: rgba(248, 81, 73, 0.15);
      border-color: rgba(248, 81, 73, 0.4);
      color: var(--vscode-editorError-foreground, #f85149);
    }
    .phase-count { font-size: 1.5em; font-weight: 700; line-height: 1.2; }
    .phase-label { font-size: 0.8em; font-weight: 600; }
    .phase-desc  { font-size: 0.72em; opacity: 0.8; }

    /* ── Library list ─────────────────────────────────────────── */
    .lib-section { margin-bottom: 8px; }
    .lib-section-title {
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .lib-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px;
      align-items: baseline;
      padding: 4px 6px;
      border-radius: 3px;
      font-size: 0.85em;
      margin-bottom: 2px;
    }
    .lib-item:hover { background: var(--vscode-list-hoverBackground); }
    .lib-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lib-version { font-size: 0.82em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .sev-badge {
      font-size: 0.72em;
      padding: 1px 5px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .sev-critical { background: rgba(188,0,0,0.3); color: #ff6b6b; }
    .sev-high     { background: rgba(210,100,0,0.25); color: var(--vscode-editorError-foreground, #f85149); }
    .sev-medium   { background: rgba(210,153,34,0.25); color: var(--vscode-editorWarning-foreground, #d29922); }
    .sev-low      { background: rgba(100,180,100,0.2); color: var(--vscode-testing-iconPassed, #3fb950); }
    .sev-unknown  { background: rgba(128,128,128,0.2); color: var(--vscode-descriptionForeground); }

    .settings-link {
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      display: block;
      margin-top: 8px;
      text-align: right;
    }
    .settings-link:hover { text-decoration: underline; }

    .hidden { display: none !important; }
  </style>
</head>
<body>

  <!-- File picker -->
  <div class="section">
    <div class="label">Vulnerability report</div>
    <div class="file-row">
      <span id="fileName" class="file-name">No file selected</span>
      <button id="browseBtn" class="secondary">Browse</button>
    </div>
  </div>

  <!-- Options -->
  <div class="section">
    <label class="checkbox-label">
      <input type="checkbox" id="verifyVersions">
      Verify registry versions
    </label>
  </div>

  <!-- Action -->
  <button id="analyzeBtn" class="primary-btn" disabled>Analyze</button>

  <!-- Status -->
  <div id="status" class="status hidden">
    <span class="spinner"></span>
    <span class="status-msg">Analyzing…</span>
  </div>

  <!-- Results -->
  <div id="results" class="hidden">
    <div class="summary-row">
      <strong id="libCount">0</strong> libraries &middot;
      <strong id="cveCount">0</strong> CVEs
    </div>
    <div class="phase-cards">
      <div class="phase-card phase-a">
        <div class="phase-count" id="phaseACount">0</div>
        <div class="phase-label">Phase A</div>
        <div class="phase-desc">Auto-apply</div>
      </div>
      <div class="phase-card phase-b">
        <div class="phase-count" id="phaseBCount">0</div>
        <div class="phase-label">Phase B</div>
        <div class="phase-desc">Review first</div>
      </div>
      <div class="phase-card phase-c">
        <div class="phase-count" id="phaseCCount">0</div>
        <div class="phase-label">Phase C</div>
        <div class="phase-desc">Manual review</div>
      </div>
    </div>
    <div id="libList"></div>
  </div>

  <a class="settings-link hidden" id="settingsLink">⚙ MendFix settings</a>

  <script>
    const vscode = acquireVsCodeApi();
    let selectedPath = '';

    const browseBtn    = document.getElementById('browseBtn');
    const analyzeBtn   = document.getElementById('analyzeBtn');
    const fileNameEl   = document.getElementById('fileName');
    const statusEl     = document.getElementById('status');
    const resultsEl    = document.getElementById('results');
    const settingsLink = document.getElementById('settingsLink');

    browseBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
    analyzeBtn.addEventListener('click', () => {
      if (!selectedPath) return;
      vscode.postMessage({
        type: 'analyze',
        reportPath: selectedPath,
        verifyVersions: document.getElementById('verifyVersions').checked,
      });
    });
    settingsLink.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

    function setFile(fsPath) {
      selectedPath = fsPath;
      fileNameEl.textContent = fsPath.split(/[\\/]/).pop();
      fileNameEl.title = fsPath;
      analyzeBtn.disabled = false;
      hide(statusEl);
      hide(resultsEl);
    }

    function show(el) { el.classList.remove('hidden'); }
    function hide(el) { el.classList.add('hidden'); }

    function sevClass(sev) {
      const s = (sev || '').toLowerCase();
      if (s === 'critical') return 'sev-critical';
      if (s === 'high')     return 'sev-high';
      if (s === 'medium')   return 'sev-medium';
      if (s === 'low')      return 'sev-low';
      return 'sev-unknown';
    }

    function renderLibSection(title, items) {
      if (!items.length) return '';
      const rows = items.map(lib => {
        const ver = lib.recommended && lib.recommended !== '—'
          ? lib.current + ' &rarr; ' + lib.recommended
          : lib.current;
        const badge = '<span class="sev-badge ' + sevClass(lib.highestSeverity) + '">'
          + (lib.highestSeverity || '?') + '</span>';
        const cves = lib.cveCount ? lib.cveCount + ' CVE' + (lib.cveCount > 1 ? 's' : '') : '';
        return '<div class="lib-item">'
          + '<div><div class="lib-name">' + escHtml(lib.name) + '</div>'
          + '<div class="lib-version">' + ver + (cves ? ' &middot; ' + cves : '') + '</div></div>'
          + badge
          + '</div>';
      }).join('');
      return '<div class="lib-section"><div class="lib-section-title">' + title + '</div>' + rows + '</div>';
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'filePicked') {
        setFile(msg.path);
        return;
      }

      if (msg.type === 'thinking') {
        analyzeBtn.disabled = true;
        statusEl.className = 'status';
        statusEl.innerHTML = '<span class="spinner"></span><span class="status-msg">Analyzing…</span>';
        show(statusEl);
        hide(resultsEl);
        return;
      }

      if (msg.type === 'result') {
        analyzeBtn.disabled = false;
        hide(statusEl);
        const d = msg.data;
        document.getElementById('libCount').textContent  = d.totalLibraries;
        document.getElementById('cveCount').textContent  = d.totalCVEs;
        document.getElementById('phaseACount').textContent = d.phaseA.length;
        document.getElementById('phaseBCount').textContent = d.phaseB.length;
        document.getElementById('phaseCCount').textContent = d.phaseC.length;
        document.getElementById('libList').innerHTML =
          renderLibSection('Phase A — Auto-apply', d.phaseA) +
          renderLibSection('Phase B — Review first', d.phaseB) +
          renderLibSection('Phase C — Manual review', d.phaseC);
        show(resultsEl);
        show(settingsLink);
        return;
      }

      if (msg.type === 'error') {
        analyzeBtn.disabled = false;
        statusEl.className = 'status error';
        const hint = msg.errorKind === 'notfound'
          ? 'File not found or unsupported format.'
          : msg.message || 'Unknown error.';
        statusEl.innerHTML = '<span class="status-msg">⚠ ' + escHtml(hint) + '</span>';
        show(statusEl);
        hide(resultsEl);
        return;
      }
    });

    // Signal to extension host that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

module.exports = { MendFixViewProvider };
