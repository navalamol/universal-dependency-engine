'use strict';

// M3.2 — Repository policy file loader and validator.
//
// Policy file: `.dependency-intelligence.yml` (or `.dependency-intelligence.yaml`)
// in the root of the target repository.
//
// Schema (all fields optional — defaults shown):
//
//   version: 1
//   policy:
//     allowedPhases: ['A']               # which phases may auto-apply
//     severityThreshold: 'MEDIUM'        # CRITICAL|HIGH|MEDIUM|LOW — skip items below this
//     blastRadiusLimit: null             # max dependents a fix may affect; null = unlimited
//     packageDenylist: []                # never auto-fix these package names
//     registryAllowlist: []              # restrict registry calls to these base URLs
//     freezeWindows:
//       - start: '2025-12-20'            # ISO date (inclusive)
//         end:   '2026-01-05'            # ISO date (inclusive)
//         reason: 'Year-end freeze'
//   verification:
//     requireVerification: false         # Phase A blocked unless build/test passed
//     requireRescan: false               # Phase A blocked unless rescan ran
//     build: []                          # [{cmd, args, required}]
//     test:  []
//   rescan:
//     enabled: false
//     provider: null                     # scanner to run post-apply

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const POLICY_FILENAMES = [
  '.dependency-intelligence.yml',
  '.dependency-intelligence.yaml',
];

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const DEFAULT_POLICY = Object.freeze({
  allowedPhases:      ['A'],
  severityThreshold:  'MEDIUM',
  blastRadiusLimit:   null,
  packageDenylist:    [],
  registryAllowlist:  [],
  freezeWindows:      [],
});

const DEFAULT_VERIFICATION = Object.freeze({
  requireVerification: false,
  requireRescan:       false,
  build: [],
  test:  [],
});

const DEFAULT_RESCAN = Object.freeze({
  enabled:  false,
  provider: null,
});

// ─── loadPolicy ──────────────────────────────────────────────────────────────

/**
 * Load and validate the policy file from a project directory.
 * Returns defaults if no file is found (non-fatal).
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] — throw on validation errors instead of using defaults
 * @returns {{ policy, verification, rescan, filePath: string|null, errors: string[] }}
 */
function loadPolicy(projectDir, opts = {}) {
  const { strict = false } = opts;

  let filePath = null;
  for (const name of POLICY_FILENAMES) {
    const candidate = path.join(projectDir, name);
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    return {
      policy:       { ...DEFAULT_POLICY },
      verification: { ...DEFAULT_VERIFICATION },
      rescan:       { ...DEFAULT_RESCAN },
      filePath:     null,
      errors:       [],
    };
  }

  const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  return _parseRaw(raw, filePath, strict);
}

/**
 * Parse a raw YAML object (already loaded) into the validated policy shape.
 * Useful for testing without filesystem access.
 *
 * @param {object} raw
 * @returns {{ policy, verification, rescan, filePath: null, errors: string[] }}
 */
function parsePolicy(raw) {
  return _parseRaw(raw || {}, null, false);
}

// ─── Gate helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if today falls inside any configured freeze window.
 * @param {{ policy: object }} loaded  - result of loadPolicy / parsePolicy
 * @param {Date} [now]
 * @returns {boolean}
 */
function isFreezeWindow(loaded, now = new Date()) {
  const windows = (loaded.policy && loaded.policy.freezeWindows) || [];
  const today   = _isoDate(now);
  return windows.some(w => {
    const start = _isoDate(new Date(w.start));
    const end   = _isoDate(new Date(w.end));
    return today >= start && today <= end;
  });
}

/**
 * Returns true if the package name is in the denylist.
 * @param {{ policy: object }} loaded
 * @param {string} packageName
 * @returns {boolean}
 */
function isDenylisted(loaded, packageName) {
  const list = (loaded.policy && loaded.policy.packageDenylist) || [];
  return list.includes(packageName);
}

/**
 * Returns true if the item's severity meets the configured threshold.
 * Items below the threshold should be skipped.
 * @param {{ policy: object }} loaded
 * @param {string} severity  - CRITICAL|HIGH|MEDIUM|LOW
 * @returns {boolean}
 */
function meetsSeverityThreshold(loaded, severity) {
  const threshold = (loaded.policy && loaded.policy.severityThreshold) || 'MEDIUM';
  const itemRank  = SEVERITY_RANK[severity] || 0;
  const minRank   = SEVERITY_RANK[threshold] || 0;
  return itemRank >= minRank;
}

/**
 * Returns true if the given phase is allowed by policy.
 * @param {{ policy: object }} loaded
 * @param {'A'|'B'|'C'} phase
 * @returns {boolean}
 */
function isPhaseAllowed(loaded, phase) {
  const allowed = (loaded.policy && loaded.policy.allowedPhases) || ['A'];
  return allowed.includes(phase);
}

/**
 * Build the gate-policy object expected by evidence-gate.js evaluateBundleGate.
 * @param {{ verification: object }} loaded
 * @returns {{ requireVerification: boolean, requireRescan: boolean }}
 */
function toGatePolicy(loaded) {
  return {
    requireVerification: !!(loaded.verification && loaded.verification.requireVerification),
    requireRescan:       !!(loaded.verification && loaded.verification.requireRescan),
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _parseRaw(raw, filePath, strict) {
  const errors = [];

  if (raw.version && raw.version !== 1) {
    errors.push(`Unsupported policy version: ${raw.version} (only version 1 is supported)`);
    if (strict) throw new Error(errors[0]);
  }

  const policy       = _mergePolicy(raw.policy, errors, strict);
  const verification = _mergeVerification(raw.verification, errors, strict);
  const rescan       = _mergeRescan(raw.rescan, errors, strict);

  return { policy, verification, rescan, filePath, errors };
}

function _mergePolicy(raw, errors, strict) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY };

  const out = { ...DEFAULT_POLICY };

  if (Array.isArray(raw.allowedPhases)) {
    const invalid = raw.allowedPhases.filter(p => !['A', 'B', 'C'].includes(p));
    if (invalid.length) {
      const msg = `Invalid allowedPhases values: ${invalid.join(', ')}`;
      errors.push(msg);
      if (strict) throw new Error(msg);
    }
    out.allowedPhases = raw.allowedPhases.filter(p => ['A', 'B', 'C'].includes(p));
  }

  if (raw.severityThreshold) {
    if (!SEVERITY_RANK[raw.severityThreshold]) {
      const msg = `Invalid severityThreshold: ${raw.severityThreshold}`;
      errors.push(msg);
      if (strict) throw new Error(msg);
    } else {
      out.severityThreshold = raw.severityThreshold;
    }
  }

  if (raw.blastRadiusLimit != null) {
    out.blastRadiusLimit = Number.isInteger(raw.blastRadiusLimit) ? raw.blastRadiusLimit : null;
  }

  if (Array.isArray(raw.packageDenylist)) out.packageDenylist = raw.packageDenylist.map(String);
  if (Array.isArray(raw.registryAllowlist)) out.registryAllowlist = raw.registryAllowlist.map(String);

  if (Array.isArray(raw.freezeWindows)) {
    out.freezeWindows = raw.freezeWindows
      .filter(w => w && w.start && w.end)
      .map(w => ({ start: w.start, end: w.end, reason: w.reason || null }));
  }

  return out;
}

function _mergeVerification(raw, errors, strict) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VERIFICATION };
  const out = { ...DEFAULT_VERIFICATION };
  if (typeof raw.requireVerification === 'boolean') out.requireVerification = raw.requireVerification;
  if (typeof raw.requireRescan === 'boolean')       out.requireRescan = raw.requireRescan;
  if (Array.isArray(raw.build)) out.build = raw.build;
  if (Array.isArray(raw.test))  out.test  = raw.test;
  return out;
}

function _mergeRescan(raw, errors, strict) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RESCAN };
  const out = { ...DEFAULT_RESCAN };
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (raw.provider) out.provider = raw.provider;
  return out;
}

function _isoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  loadPolicy,
  parsePolicy,
  isFreezeWindow,
  isDenylisted,
  meetsSeverityThreshold,
  isPhaseAllowed,
  toGatePolicy,
  DEFAULT_POLICY,
  DEFAULT_VERIFICATION,
  DEFAULT_RESCAN,
  SEVERITY_RANK,
};
