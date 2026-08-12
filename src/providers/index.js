'use strict';

const path = require('path');
const fs   = require('fs');

const snyk       = require('./snyk');
const npmAudit   = require('./npm-audit');
const dependabot = require('./dependabot');
const owasp      = require('./owasp');
const osv        = require('./osv');
const trivy      = require('./trivy');
const gitlab     = require('./gitlab');
const xray       = require('./xray');

/**
 * Auto-detect vulnerability report provider from file format.
 *
 * Detection order (most-specific fingerprint first to avoid false matches):
 *   1. .xlsx / .xls             → mend
 *   2. Trivy JSON               → trivy      (SchemaVersion: number, Results: array)
 *   3. JFrog Xray JSON          → xray       (data[].components[].component_id)
 *   4. npm audit JSON           → npm-audit  (auditReportVersion or advisories+metadata)
 *   5. Dependabot alerts JSON   → dependabot (array of {security_advisory, dependency})
 *   6. OWASP Dep-Check JSON     → owasp      (reportSchema + dependencies[])
 *   7. OSV JSON                 → osv        (results[].packages or vulns[].affected)
 *   8. GitLab Security Report   → gitlab     (version string + vulnerabilities[].location.dependency)
 *   9. Snyk JSON                → snyk       (packageManager or vulnerabilities with fixedIn)
 *  10. Mend vulnerabilities[]   → mend
 *  11. default                  → mend
 *
 * Pass --provider <name> to the CLI to skip detection entirely.
 */
function detectProvider(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'mend';

  if (ext === '.json') {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return 'mend'; }

    if (trivy.isTrivyFormat(data))          return 'trivy';
    if (xray.isXrayFormat(data))            return 'xray';
    if (npmAudit.isNpmAuditFormat(data))    return 'npm-audit';
    if (dependabot.isDependabotFormat(data)) return 'dependabot';
    if (owasp.isOwaspFormat(data))          return 'owasp';
    if (osv.isOsvFormat(data))              return 'osv';
    if (gitlab.isGitlabFormat(data))        return 'gitlab';
    if (snyk.isSnykFormat(data))            return 'snyk';
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
  osv,
  trivy,
  gitlab,
  xray,
};

/** Provider names exposed for --provider flag validation and help text. */
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
