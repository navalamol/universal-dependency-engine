'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');

// Engine lives two levels up from packages/vscode-extension/
const ENGINE_PATH = path.join(__dirname, '..', '..', 'mendfix.js');

class MendFixPanel {
  static currentPanel = undefined;
  static viewType = 'mendfix';

  /**
   * Creates or reveals the panel. Returns the panel instance.
   */
  static createOrShow(context) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MendFixPanel.currentPanel) {
      MendFixPanel.currentPanel._panel.reveal(column);
      return MendFixPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      MendFixPanel.viewType,
      'MendFix',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      }
    );

    MendFixPanel.currentPanel = new MendFixPanel(panel, context);
    return MendFixPanel.currentPanel;
  }

  constructor(panel, context) {
    this._panel = panel;
    this._context = context;
    this._disposables = [];
    this._nonce = crypto.randomBytes(16).toString('hex');

    this._panel.webview.html = this._getHtmlForWebview(this._nonce);

    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  /** Called from analyzeReport command when a JSON file is right-clicked. */
  _loadReport(fsPath) {
    this._panel.webview.postMessage({ command: 'loadReport', path: fsPath });
  }

  async _handleMessage(message) {
    switch (message.command) {
      case 'analyze':
        await this._runAnalyze(message);
        break;
      case 'apply':
        await this._runApply(message);
        break;
      case 'portfolio':
        await this._runPortfolio(message);
        break;
      case 'getSecret':
        await this._getSecret(message.key);
        break;
      case 'setSecret':
        await this._setSecret(message.key, message.value);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Engine stubs — wired in Phase 6 Step 2 (analyze) and Step 3 (apply/portfolio)
  // ---------------------------------------------------------------------------

  async _runAnalyze({ reportPath, verifyVersions }) {
    try {
      // Step 2 implementation: require(ENGINE_PATH) and call analyze programmatically
      this._panel.webview.postMessage({
        command: 'analyzeResult',
        data: null,
        error: 'Phase 6 Step 2 not yet implemented',
      });
    } catch (err) {
      this._panel.webview.postMessage({ command: 'analyzeResult', error: err.message });
    }
  }

  async _runApply({ reportPath, outDir }) {
    try {
      // Step 3 implementation: apply flow, rollback on failure
      this._panel.webview.postMessage({
        command: 'applyResult',
        data: null,
        error: 'Phase 6 Step 3 not yet implemented',
      });
    } catch (err) {
      this._panel.webview.postMessage({ command: 'applyResult', error: err.message });
    }
  }

  async _runPortfolio({ configPath }) {
    try {
      // Step 3 implementation: portfolio run
      this._panel.webview.postMessage({
        command: 'portfolioResult',
        data: null,
        error: 'Phase 6 Step 3 not yet implemented',
      });
    } catch (err) {
      this._panel.webview.postMessage({ command: 'portfolioResult', error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Secret storage (platform tokens — never stored in webview state)
  // ---------------------------------------------------------------------------

  async _getSecret(key) {
    const value = await this._context.secrets.get(key);
    this._panel.webview.postMessage({ command: 'secretValue', key, value: value || null });
  }

  async _setSecret(key, value) {
    await this._context.secrets.store(key, value);
    this._panel.webview.postMessage({ command: 'secretStored', key });
  }

  // ---------------------------------------------------------------------------
  // HTML scaffold — full UI replaces this in Phase 6 Step 2
  // ---------------------------------------------------------------------------

  _getHtmlForWebview(nonce) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>MendFix</title>
  <style>
    :root {
      --gap: 16px;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: var(--gap) calc(var(--gap) * 2);
      margin: 0;
    }
    h1 { font-size: 1.3em; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: calc(var(--gap) * 1.5); }
    .status {
      padding: 12px 16px;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-focusBorder);
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-size: 0.92em;
    }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <h1>MendFix</h1>
  <p class="subtitle">Automated vulnerability remediation — Mend · Snyk · Dependabot · npm-audit · and more</p>
  <div class="status">
    <strong>Scaffold ready.</strong> Report Upload &amp; Analysis UI arrives in Phase 6 Step 2.<br>
    Right-click any <code>.json</code> vulnerability report in the Explorer and choose
    <em>MendFix: Analyze Vulnerability Report</em> to open this panel with a pre-loaded path.
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'loadReport') {
        console.log('MendFix: report path received from host:', msg.path);
        // Step 2 wires this into the analyze UI
      }
    });
  </script>
</body>
</html>`;
  }

  dispose() {
    MendFixPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}

module.exports = { MendFixPanel };
