'use strict';

const vscode = require('vscode');
const { MendFixPanel } = require('./panel');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mendfix.openPanel', () => {
      MendFixPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('mendfix.analyzeReport', (uri) => {
      const panel = MendFixPanel.createOrShow(context);
      if (uri) {
        MendFixPanel.currentPanel._loadReport(uri.fsPath);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
