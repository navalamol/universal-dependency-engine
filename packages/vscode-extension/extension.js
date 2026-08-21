'use strict';

const vscode = require('vscode');
const { MendFixViewProvider } = require('./panel');

function activate(context) {
  const provider = new MendFixViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MendFixViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mendfix.openPanel', () => {
      vscode.commands.executeCommand('mendfix.panel.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mendfix.analyzeReport', (uri) => {
      if (uri && uri.fsPath) {
        provider.loadFile(uri.fsPath);
      }
      vscode.commands.executeCommand('mendfix.panel.focus');
    })
  );

  // Load demo output (invoked by `mendfix demo --ui` via URI or command)
  context.subscriptions.push(
    vscode.commands.registerCommand('mendfix.loadDemo', () => {
      vscode.commands.executeCommand('mendfix.panel.focus');
      provider.loadDemoOutput();
    })
  );

  // URI handler: vscode://mendfix.mendfix-vscode/loadDemo
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/loadDemo') {
          vscode.commands.executeCommand('mendfix.loadDemo');
        }
      },
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
