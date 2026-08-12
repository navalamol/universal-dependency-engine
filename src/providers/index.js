'use strict';

const path = require('path');
const fs   = require('fs');

const snyk = require('./snyk');

// Detect vulnerability report provider from file format.
function detectProvider(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'mend';
  if (ext === '.json') {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (snyk.isSnykFormat(data)) return 'snyk';
      if (Array.isArray(data.vulnerabilities)) return 'mend';
    } catch { /* fall through to default */ }
  }
  return 'mend';
}

const PROVIDERS = {
  mend: require('./mend'),
  snyk,
};

function getParser(provider) {
  const parser = PROVIDERS[provider];
  if (!parser) throw new Error(`Unknown provider: ${provider}`);
  return parser;
}

module.exports = { detectProvider, getParser };
