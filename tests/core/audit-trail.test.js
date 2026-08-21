'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { createTrail, readTrailFile, queryTrail, EVENTS } = require('../../src/core/audit-trail');

// ─── EVENTS enum ─────────────────────────────────────────────────────────────

test('EVENTS is frozen and contains expected event types', () => {
  expect(Object.isFrozen(EVENTS)).toBe(true);
  const required = [
    'ANALYSIS_STARTED', 'ANALYSIS_COMPLETED', 'GATE_EVALUATED',
    'VERIFICATION_RAN', 'RESCAN_RAN', 'APPLY_STARTED', 'APPLY_COMPLETED',
    'POLICY_LOADED',
  ];
  for (const e of required) expect(EVENTS[e]).toBe(e);
});

// ─── createTrail ─────────────────────────────────────────────────────────────

test('createTrail returns a trail object with expected methods', () => {
  const trail = createTrail({ runId: 'test-run-1' });
  expect(typeof trail.record).toBe('function');
  expect(typeof trail.getEntries).toBe('function');
  expect(typeof trail.toNdjson).toBe('function');
  expect(typeof trail.flush).toBe('function');
});

test('createTrail meta is populated correctly', () => {
  const trail = createTrail({ runId: 'r1', project: 'proj', ecosystem: 'npm' });
  expect(trail.meta.runId).toBe('r1');
  expect(trail.meta.project).toBe('proj');
  expect(trail.meta.ecosystem).toBe('npm');
});

test('createTrail assigns a runId automatically when not provided', () => {
  const trail = createTrail();
  expect(typeof trail.meta.runId).toBe('string');
  expect(trail.meta.runId.length).toBeGreaterThan(0);
});

// ─── record + getEntries ──────────────────────────────────────────────────────

test('record adds an entry with timestamp and event', () => {
  const trail = createTrail({ runId: 'r1' });
  trail.record(EVENTS.ANALYSIS_STARTED, { ecosystem: 'npm' });
  const entries = trail.getEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0].event).toBe(EVENTS.ANALYSIS_STARTED);
  expect(entries[0].runId).toBe('r1');
  expect(typeof entries[0].timestamp).toBe('string');
  expect(entries[0].ecosystem).toBe('npm');
});

test('record can be called multiple times', () => {
  const trail = createTrail();
  trail.record(EVENTS.ANALYSIS_STARTED);
  trail.record(EVENTS.GATE_EVALUATED, { decision: 'ALLOWED' });
  trail.record(EVENTS.ANALYSIS_COMPLETED, { totalItems: 5 });
  expect(trail.getEntries()).toHaveLength(3);
});

test('getEntries returns a copy — mutations do not affect the trail', () => {
  const trail = createTrail();
  trail.record(EVENTS.ANALYSIS_STARTED);
  const entries = trail.getEntries();
  entries.push({ fake: true });
  expect(trail.getEntries()).toHaveLength(1); // original unchanged
});

// ─── toNdjson ─────────────────────────────────────────────────────────────────

test('toNdjson returns one JSON line per entry', () => {
  const trail = createTrail({ runId: 'r1' });
  trail.record(EVENTS.ANALYSIS_STARTED);
  trail.record(EVENTS.ANALYSIS_COMPLETED, { count: 5 });
  const ndjson = trail.toNdjson();
  const lines  = ndjson.trim().split('\n');
  expect(lines).toHaveLength(2);
  const parsed = lines.map(l => JSON.parse(l));
  expect(parsed[0].event).toBe(EVENTS.ANALYSIS_STARTED);
  expect(parsed[1].count).toBe(5);
});

test('toNdjson returns empty string for empty trail', () => {
  const trail = createTrail();
  expect(trail.toNdjson()).toBe('');
});

test('toNdjson output is valid JSON on each line', () => {
  const trail = createTrail();
  trail.record(EVENTS.GATE_EVALUATED, { libraryName: 'lodash', decision: 'ALLOWED' });
  const line = trail.toNdjson().trim();
  expect(() => JSON.parse(line)).not.toThrow();
});

// ─── flush + readFile ─────────────────────────────────────────────────────────

test('flush writes NDJSON to disk and readFile reads it back', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const outFile = path.join(tmpDir, 'audit.ndjson');

  const trail = createTrail({ runId: 'r1', project: 'proj' });
  trail.record(EVENTS.ANALYSIS_STARTED, { ecosystem: 'npm' });
  trail.record(EVENTS.ANALYSIS_COMPLETED, { totalItems: 3 });
  trail.flush(outFile);

  const read = trail.readFile(outFile);
  expect(read).toHaveLength(2);
  expect(read[0].event).toBe(EVENTS.ANALYSIS_STARTED);
  expect(read[1].totalItems).toBe(3);

  fs.unlinkSync(outFile);
  fs.rmdirSync(tmpDir);
});

test('flush is append-only: two flushes accumulate entries', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const outFile = path.join(tmpDir, 'audit.ndjson');

  const t1 = createTrail({ runId: 'run1' });
  t1.record(EVENTS.ANALYSIS_STARTED);
  t1.flush(outFile);

  const t2 = createTrail({ runId: 'run2' });
  t2.record(EVENTS.ANALYSIS_COMPLETED, { count: 7 });
  t2.flush(outFile);

  const all = readTrailFile(outFile);
  expect(all).toHaveLength(2);
  expect(all[0].runId).toBe('run1');
  expect(all[1].runId).toBe('run2');

  fs.unlinkSync(outFile);
  fs.rmdirSync(tmpDir);
});

test('readTrailFile returns empty array for non-existent file', () => {
  expect(readTrailFile('/non/existent/path.ndjson')).toEqual([]);
});

test('flush creates directory if it does not exist', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const subDir  = path.join(tmpDir, 'deep', 'nested');
  const outFile = path.join(subDir, 'audit.ndjson');

  const trail = createTrail();
  trail.record(EVENTS.ANALYSIS_STARTED);
  trail.flush(outFile);

  expect(fs.existsSync(outFile)).toBe(true);

  fs.unlinkSync(outFile);
  fs.rmdirSync(path.join(tmpDir, 'deep', 'nested'));
  fs.rmdirSync(path.join(tmpDir, 'deep'));
  fs.rmdirSync(tmpDir);
});

// ─── queryTrail ──────────────────────────────────────────────────────────────

test('queryTrail filters by event type', () => {
  const entries = [
    { event: EVENTS.ANALYSIS_STARTED,   runId: 'r1', project: 'p1' },
    { event: EVENTS.GATE_EVALUATED,     runId: 'r1', project: 'p1' },
    { event: EVENTS.ANALYSIS_COMPLETED, runId: 'r1', project: 'p1' },
  ];
  const filtered = queryTrail(entries, { event: EVENTS.GATE_EVALUATED });
  expect(filtered).toHaveLength(1);
  expect(filtered[0].event).toBe(EVENTS.GATE_EVALUATED);
});

test('queryTrail filters by runId', () => {
  const entries = [
    { event: EVENTS.ANALYSIS_STARTED, runId: 'r1', project: 'p' },
    { event: EVENTS.ANALYSIS_STARTED, runId: 'r2', project: 'p' },
  ];
  expect(queryTrail(entries, { runId: 'r1' })).toHaveLength(1);
});

test('queryTrail with no filters returns all entries', () => {
  const entries = [
    { event: EVENTS.ANALYSIS_STARTED },
    { event: EVENTS.APPLY_COMPLETED },
  ];
  expect(queryTrail(entries, {})).toHaveLength(2);
});
