'use strict';

const path = require('path');
const fs   = require('fs');

const snyk      = require('./snyk');
const npmAudit  = require('./npm-audit');
const dependabot = require('./dependabot');
const owasp     = require('./owasp');

/**
 * Auto-detect vulnerability report provider from file format.
 *
 * Detection order (most specific first to avoid false matches):
 *   1. .xlsx / .xls           → mend
 *   2. npm audit JSON          → npm-audit   (auditReportVersion or advisories+metadata)
 *   3. Dependabot alerts JSON  → dependabot  (array of {security_advisory, dependency})
 *   4. OWASP Dep-Check JSON    → owasp       (reportSchema + dependencies[])
 *   5. Snyk JSON               → snyk        (packageManager or vulnerabilities with fixedIn)
 *   6. Mend vulnerabilities[]  → mend
 *   7. default                 → mend
 *
 * Pass provider name explicitly via --provider to skip detection.
 */
function detectProvider(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'mend';

  if (ext === '.json') {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return 'mend'; }

    if (npmAudit.isNpmAuditFormat(data))    return 'npm-audit';
    if (dependabot.isDependabotFormat(data)) return 'dependabot';
    if (owasp.isOwaspFormat(data))           return 'owasp';
    if (snyk.isSnykFormat(data))             return 'snyk';
    if (Array.isArray(data.vulnerabilities)) return 'mend';
  }

  return 'mend';
}

const PROVIDERS = {
  mend:        require('./mend'),
  snyk,
  'npm-audit':  npmAudit,
  dependabot,
  owasp,
};

/** Return the provider names supported for --provider flag help text. */
const PROVIDER_NAMES = Object.keys(PROVIDERS);

function getParser(provider) {
  const parser = PROVIDERS[provider];
  if (!parser) {
    throw new Error(
      `Unknown provider: "${provider}". Valid values: ${PROVIDER_NAMES.join(', ')}`
    );
  }
  return parser;
}

module.exports = { detectProvider, getParser, PROVIDER_NAMES };
