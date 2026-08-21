'use strict';

// D3.3 — Internal fork workflow.
// Builds fork specifications for scoped private packages and maintains a
// fork-debt ledger with owner + expiry tracking.
// Integrates with FORKED outcome in evidence-model.js.

const fs   = require('fs');
const path = require('path');

const FORK_STATUS = Object.freeze({
  ACTIVE:    'ACTIVE',    // fork is current dependency
  RESOLVED:  'RESOLVED',  // upstream fix shipped; fork can be removed
  EXPIRED:   'EXPIRED',   // past expiry date with no resolution — escalate
  ABANDONED: 'ABANDONED', // fork is no longer maintained
});

const FORK_REASON = Object.freeze({
  NO_UPSTREAM_FIX:     'NO_UPSTREAM_FIX',
  BACKPORT_RISK:       'BACKPORT_RISK',
  LICENSE_RESTRICTION: 'LICENSE_RESTRICTION',
  EMERGENCY_PATCH:     'EMERGENCY_PATCH',
  LONG_TERM_DIVERGE:   'LONG_TERM_DIVERGE',
});

/**
 * Create a fork specification for a PhasedItem.
 *
 * @param {object} item         PhasedItem
 * @param {string} org          npm scope (e.g. 'myorg' → '@myorg/pkg')
 * @param {object} [opts]
 * @param {string} [opts.owner]           owner email or username
 * @param {number} [opts.expiryDays=180]  days until fork expires
 * @param {string} [opts.reason]          FORK_REASON value
 * @param {string} [opts.createdAt]       ISO timestamp
 * @returns {ForkSpec}
 */
function createForkSpec(item, org, opts = {}) {
  if (!item || !item.libraryName) throw new Error('item.libraryName required');
  if (!org || typeof org !== 'string') throw new Error('org (npm scope) required');

  const {
    owner      = null,
    expiryDays = 180,
    reason     = FORK_REASON.NO_UPSTREAM_FIX,
    createdAt  = new Date().toISOString(),
  } = opts;

  const safeName   = item.libraryName.replace(/^@[^/]+\//, '');
  const scopedName = `@${org}/${safeName}`;
  const expiresAt  = _addDays(createdAt, expiryDays);

  return {
    originalPackage: item.libraryName,
    scopedName,
    fromVersion:     item.currentVersion,
    targetVersion:   item.recommendedVersion || null,
    owner,
    reason,
    status:          FORK_STATUS.ACTIVE,
    createdAt,
    expiresAt,
    cves:            (item.cves || []).map(c => c.id),
    phase:           item.phase || null,
    notes:           null,
  };
}

/**
 * Build a fork-debt ledger from multiple fork specs.
 * Automatically marks ACTIVE specs past their expiry as EXPIRED.
 *
 * @param {ForkSpec[]} specs
 * @param {object} [opts]
 * @param {string} [opts.now]  ISO timestamp for expiry comparison
 * @returns {ForkDebtLedger}
 */
function buildForkDebtLedger(specs, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();

  const entries = (specs || []).map(spec => {
    const expired = spec.status === FORK_STATUS.ACTIVE && new Date(spec.expiresAt) < now;
    return { ...spec, status: expired ? FORK_STATUS.EXPIRED : spec.status };
  });

  return {
    generatedAt: now.toISOString(),
    totalForks:  entries.length,
    active:      entries.filter(e => e.status === FORK_STATUS.ACTIVE).length,
    expired:     entries.filter(e => e.status === FORK_STATUS.EXPIRED).length,
    resolved:    entries.filter(e => e.status === FORK_STATUS.RESOLVED).length,
    entries,
  };
}

/**
 * Write fork-debt ledger to markdown + JSON.
 *
 * @param {ForkDebtLedger} ledger
 * @param {string} outDir
 * @returns {string} path to written markdown file
 */
function writeForkDebtLedger(ledger, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const rows = (ledger.entries || []).map(e => {
    const owner   = e.owner || '—';
    const expires = e.expiresAt ? e.expiresAt.split('T')[0] : '—';
    return `| ${e.originalPackage} | ${e.scopedName} | ${owner} | ${e.reason} | ${e.status} | ${expires} |`;
  });

  const lines = [
    '# Fork Debt Ledger',
    '',
    `Generated: ${ledger.generatedAt}`,
    `Total: ${ledger.totalForks} | Active: ${ledger.active} | Expired: ${ledger.expired} | Resolved: ${ledger.resolved}`,
    '',
    '| Package | Scoped Name | Owner | Reason | Status | Expires |',
    '|---------|-------------|-------|--------|--------|---------|',
    ...rows,
  ];

  if (ledger.expired > 0) {
    lines.push('', `> **Warning:** ${ledger.expired} fork(s) past expiry date — escalate or resolve.`);
  }

  const mdPath   = path.join(outDir, 'fork-debt-ledger.md');
  const jsonPath = path.join(outDir, 'fork-debt-ledger.json');
  fs.writeFileSync(mdPath,   lines.join('\n'),              'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(ledger, null, 2), 'utf8');
  return mdPath;
}

function _addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

module.exports = {
  FORK_STATUS,
  FORK_REASON,
  createForkSpec,
  buildForkDebtLedger,
  writeForkDebtLedger,
};
