'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { scanDirectory, parseImports, buildFingerprint } = require('../../src/core/usage-fingerprint');

// ─── parseImports ────────────────────────────────────────────────────────────

test('parseImports detects require statement', () => {
  const content = `const lodash = require('lodash');`;
  const results = parseImports(content, 'test.js', 'lodash');
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('require');
  expect(results[0].file).toBe('test.js');
  expect(results[0].line).toBe(1);
});

test('parseImports detects ES6 import statement', () => {
  const content = `import { cloneDeep } from 'lodash';`;
  const results = parseImports(content, 'test.js', 'lodash');
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('import');
  expect(results[0].symbols).toContain('cloneDeep');
});

test('parseImports detects namespace import', () => {
  const content = `import * as _ from 'lodash';`;
  const results = parseImports(content, 'test.js', 'lodash');
  expect(results[0].symbols).toContain('* as _');
});

test('parseImports detects default import', () => {
  const content = `import axios from 'axios';`;
  const results = parseImports(content, 'test.js', 'axios');
  expect(results[0].symbols).toContain('axios');
});

test('parseImports extracts destructured require symbols', () => {
  const content = `const { merge, cloneDeep } = require('lodash');`;
  const results = parseImports(content, 'test.js', 'lodash');
  expect(results[0].symbols).toContain('merge');
  expect(results[0].symbols).toContain('cloneDeep');
});

test('parseImports detects scoped package import', () => {
  const content = `import { run } from '@jest/core';`;
  const results = parseImports(content, 'test.js', '@jest/core');
  expect(results).toHaveLength(1);
});

test('parseImports detects subpath import', () => {
  const content = `const merge = require('lodash/merge');`;
  const results = parseImports(content, 'test.js', 'lodash');
  expect(results).toHaveLength(1);
  expect(results[0].subpath).toBe('merge');
});

test('parseImports filters by targetPackage', () => {
  const content = `import axios from 'axios';\nimport _ from 'lodash';`;
  const axiosResults = parseImports(content, 'test.js', 'axios');
  expect(axiosResults).toHaveLength(1);
  expect(axiosResults[0].statement).toContain('axios');
});

test('parseImports returns all imports when no targetPackage given', () => {
  const content = `const a = require('a');\nconst b = require('b');`;
  const results = parseImports(content, 'test.js');
  expect(results).toHaveLength(2);
});

test('parseImports deduplicates by file+line', () => {
  // A line that matches both require and import patterns should appear once
  const content = `const { get } = require('lodash');`;
  const results = parseImports(content, 'f.js', 'lodash');
  const uniqueLines = new Set(results.map(r => r.line));
  expect(uniqueLines.size).toBe(results.length);
});

// ─── buildFingerprint ────────────────────────────────────────────────────────

test('buildFingerprint with no usages returns trivial effort', () => {
  const scanResult = { packageName: 'lodash', usages: [], filesWithUsage: 0, symbols: [], subpaths: [] };
  const fp = buildFingerprint(scanResult);
  expect(fp.effortEstimate).toBe('trivial');
  expect(fp.packageName).toBe('lodash');
});

test('buildFingerprint with 1 file, 3 usages returns low effort', () => {
  const usages = [
    { file: 'a.js', line: 1 },
    { file: 'a.js', line: 5 },
    { file: 'a.js', line: 10 },
  ];
  const scanResult = { packageName: 'lodash', usages, filesWithUsage: 1, symbols: ['merge'], subpaths: [] };
  expect(buildFingerprint(scanResult).effortEstimate).toBe('low');
});

test('buildFingerprint with 15 files returns high effort', () => {
  const usages = Array.from({ length: 40 }, (_, i) => ({ file: `file${i}.js`, line: 1 }));
  const scanResult = { packageName: 'request', usages, filesWithUsage: 15, symbols: ['get', 'post', 'put'], subpaths: [] };
  expect(buildFingerprint(scanResult).effortEstimate).toBe('high');
});

test('buildFingerprint includes effortBasis string', () => {
  const scanResult = { packageName: 'x', usages: [{ file: 'a.js', line: 1 }], filesWithUsage: 1, symbols: ['y'], subpaths: [] };
  const fp = buildFingerprint(scanResult);
  expect(typeof fp.effortBasis).toBe('string');
  expect(fp.effortBasis.length).toBeGreaterThan(0);
});

// ─── scanDirectory ───────────────────────────────────────────────────────────

test('scanDirectory on a directory with matching files returns correct counts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-scan-'));
  fs.writeFileSync(path.join(tmpDir, 'a.js'), `const _ = require('lodash');\n`, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'b.js'), `import { merge } from 'lodash';\n`, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'c.js'), `const axios = require('axios');\n`, 'utf8'); // different pkg

  const result = scanDirectory(tmpDir, 'lodash');
  expect(result.packageName).toBe('lodash');
  expect(result.filesWithUsage).toBe(2);
  expect(result.usages.length).toBeGreaterThanOrEqual(2);
  expect(result.limitHit).toBe(false);

  fs.unlinkSync(path.join(tmpDir, 'a.js'));
  fs.unlinkSync(path.join(tmpDir, 'b.js'));
  fs.unlinkSync(path.join(tmpDir, 'c.js'));
  fs.rmdirSync(tmpDir);
});

test('scanDirectory skips node_modules', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-scan-'));
  const nmDir  = path.join(tmpDir, 'node_modules', 'lodash');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, 'index.js'), `module.exports = {};`, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'app.js'), `const _ = require('lodash');\n`, 'utf8');

  const result = scanDirectory(tmpDir, 'lodash');
  // Only app.js should be scanned, not node_modules/lodash/index.js
  expect(result.filesScanned).toBe(1);

  fs.unlinkSync(path.join(tmpDir, 'app.js'));
  fs.unlinkSync(path.join(nmDir, 'index.js'));
  fs.rmdirSync(nmDir);
  fs.rmdirSync(path.join(tmpDir, 'node_modules'));
  fs.rmdirSync(tmpDir);
});

test('scanDirectory on empty directory returns zero usages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-empty-'));
  const result = scanDirectory(tmpDir, 'lodash');
  expect(result.filesScanned).toBe(0);
  expect(result.filesWithUsage).toBe(0);
  expect(result.usages).toEqual([]);
  fs.rmdirSync(tmpDir);
});

test('scanDirectory respects maxFiles limit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-limit-'));
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(tmpDir, `f${i}.js`), `require('pkg');\n`, 'utf8');
  }
  const result = scanDirectory(tmpDir, 'pkg', { maxFiles: 3 });
  expect(result.filesScanned).toBe(3);
  expect(result.limitHit).toBe(true);
  for (let i = 0; i < 5; i++) fs.unlinkSync(path.join(tmpDir, `f${i}.js`));
  fs.rmdirSync(tmpDir);
});

test('scanDirectory collects deduplicated symbols and subpaths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-syms-'));
  fs.writeFileSync(path.join(tmpDir, 'a.js'), `import { merge } from 'lodash';\n`, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'b.js'), `const m = require('lodash/merge');\n`, 'utf8');
  const result = scanDirectory(tmpDir, 'lodash');
  expect(result.symbols).toContain('merge');
  expect(result.subpaths).toContain('merge');
  fs.unlinkSync(path.join(tmpDir, 'a.js'));
  fs.unlinkSync(path.join(tmpDir, 'b.js'));
  fs.rmdirSync(tmpDir);
});
