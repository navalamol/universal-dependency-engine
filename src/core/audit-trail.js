'use strict';

// M3.3 — Append-only structured audit trail.
//
// Events are recorded as newline-delimited JSON (NDJSON) in memory,
// then flushed to disk. Once written, a trail file is never modified —
// new events are always appended to the end of the file.
//
// Event types:
//   ANALYSIS_STARTED      — pipeline began
//   ANALYSIS_COMPLETED    — pipeline ended (counts + timing)
//   GATE_EVALUATED        — evidence gate decision per item
//   VERIFICATION_RAN      — build/test verification result
//   RESCAN_RAN            — post-remediation rescan result
//   EXPOSURE_CLASSIFIED   — D1A result per item
//   APPLY_STARTED         — Phase A application began
//   APPLY_COMPLETED       — Phase A application result
//   POLICY_LOADED         — policy file read
//   POLICY_FREEZE_BLOCKED — action blocked by freeze window

const fs   = require('fs');
const path = require('path');

const EVENTS = Object.freeze({
  ANALYSIS_STARTED:       'ANALYSIS_STARTED',
  ANALYSIS_COMPLETED:     'ANALYSIS_COMPLETED',
  GATE_EVALUATED:         'GATE_EVALUATED',
  VERIFICATION_RAN:       'VERIFICATION_RAN',
  RESCAN_RAN:             'RESCAN_RAN',
  EXPOSURE_CLASSIFIED:    'EXPOSURE_CLASSIFIED',
  APPLY_STARTED:          'APPLY_STARTED',
  APPLY_COMPLETED:        'APPLY_COMPLETED',
  POLICY_LOADED:          'POLICY_LOADED',
  POLICY_FREEZE_BLOCKED:  'POLICY_FREEZE_BLOCKED',
});

// ─── createTrail ─────────────────────────────────────────────────────────────

/**
 * Create a new in-memory audit trail.
 *
 * @param {object} [opts]
 * @param {string} [opts.runId]     - unique run identifier
 * @param {string} [opts.project]   - project / repo name
 * @param {string} [opts.provider]  - scanner provider
 * @param {string} [opts.ecosystem] - npm|maven|...
 * @returns {Trail}
 */
function createTrail(opts = {}) {
  const entries = [];
  const meta = {
    runId:     opts.runId     || `run-${Date.now()}`,
    project:   opts.project   || null,
    provider:  opts.provider  || null,
    ecosystem: opts.ecosystem || null,
  };

  /**
   * Record one audit event.
   * @param {string} event   - EVENTS value
   * @param {object} [data]  - event-specific payload
   */
  function record(event, data = {}) {
    entries.push({
      timestamp: new Date().toISOString(),
      event,
      runId: meta.runId,
      project: meta.project,
      ...data,
    });
  }

  /**
   * Return all recorded entries (read-only snapshot).
   * @returns {object[]}
   */
  function getEntries() {
    return [...entries];
  }

  /**
   * Serialize entries to NDJSON string.
   * @returns {string}
   */
  function toNdjson() {
    return entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  }

  /**
   * Append entries to an NDJSON file (creates the file if absent).
   * Never overwrites — always appends. Directory is created if needed.
   *
   * @param {string} filePath
   * @returns {string} filePath that was written
   */
  function flush(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, toNdjson(), 'utf8');
    return filePath;
  }

  /**
   * Read all entries from an existing NDJSON trail file.
   * Returns an empty array if the file does not exist.
   *
   * @param {string} filePath
   * @returns {object[]}
   */
  function readFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  return { meta, record, getEntries, toNdjson, flush, readFile };
}

// ─── readTrailFile ────────────────────────────────────────────────────────────

/**
 * Read a trail file and return all recorded entries.
 * Returns empty array if file does not exist.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readTrailFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

/**
 * Query a trail entry array, optionally filtered by event type or runId.
 *
 * @param {object[]} entries
 * @param {object}   [filters]
 * @param {string}   [filters.event]
 * @param {string}   [filters.runId]
 * @param {string}   [filters.project]
 * @returns {object[]}
 */
function queryTrail(entries, filters = {}) {
  return entries.filter(e => {
    if (filters.event   && e.event   !== filters.event)   return false;
    if (filters.runId   && e.runId   !== filters.runId)   return false;
    if (filters.project && e.project !== filters.project) return false;
    return true;
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { createTrail, readTrailFile, queryTrail, EVENTS };
