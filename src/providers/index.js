'use strict';

const path = require('path');
const fs   = require('fs');

// Detect vulnerability report provider from file format.
// Currently only Mend is supported; this becomes the extension point
// when Phase 2 adds Snyk, Dependabot, npm audit, etc.
function detectProvider(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'mend';
  if (ext === '.json') {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data.vulnerabilities)) return 'mend';
      // Future: if (data.runs) return 'sarif'; // Snyk/GitHub Advisory SARIF
      // Future: if (data.vulnerabilities && data.metadata) return 'snyk';
    } catch { /* fall through to default */ }
  }
  return 'mend';
}

function getParser(provider) {
  return require(`./${provider}`);
}

module.exports = { detectProvider, getParser };
