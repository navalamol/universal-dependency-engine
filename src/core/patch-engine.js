'use strict';

// D3.1 — Native npm patch support.
// Creates version-specific unified diffs and applies them to installed packages.
// Patch hashes (SHA-256) are recorded in evidence via buildPatchEvidence.

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const PATCH_STATUS = Object.freeze({
  CREATED:  'CREATED',
  APPLIED:  'APPLIED',
  VERIFIED: 'VERIFIED',
  FAILED:   'FAILED',
  SKIPPED:  'SKIPPED',
});

/**
 * Compute SHA-256 hash of a diff string.
 * @param {string} diff
 * @returns {string} hex digest
 */
function hashDiff(diff) {
  return crypto.createHash('sha256').update(diff || '', 'utf8').digest('hex');
}

/**
 * Create a PatchData record.
 *
 * @param {string} pkgName
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {string} [diff='']   unified diff text
 * @returns {PatchData}
 */
function createPatch(pkgName, fromVersion, toVersion, diff = '') {
  if (!pkgName)      throw new Error('pkgName required');
  if (!fromVersion)  throw new Error('fromVersion required');
  if (!toVersion)    throw new Error('toVersion required');

  return {
    pkgName,
    fromVersion,
    toVersion,
    diff,
    hash:      hashDiff(diff),
    status:    PATCH_STATUS.CREATED,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Apply a patch to an installed package directory by writing the patch file.
 *
 * @param {string}    installDir  path to installed package root
 * @param {PatchData} patchData
 * @param {object}    [opts]
 * @param {boolean}   [opts.dryRun=false]
 * @returns {{ applied: boolean, patchFile?: string, dryRun?: boolean, error?: string }}
 */
function applyPatch(installDir, patchData, opts = {}) {
  const { dryRun = false } = opts;

  if (!installDir) return { applied: false, error: 'installDir required' };
  if (!patchData || !patchData.diff) {
    return { applied: false, error: 'patchData.diff is empty — nothing to apply' };
  }

  if (dryRun) return { applied: false, dryRun: true, patchFile: null };

  try {
    if (!fs.existsSync(installDir)) {
      return { applied: false, error: `installDir not found: ${installDir}` };
    }
    const fileName  = `${patchData.pkgName}-${patchData.fromVersion}-${patchData.toVersion}.patch`;
    const patchFile = path.join(installDir, fileName);
    fs.writeFileSync(patchFile, patchData.diff, 'utf8');
    return { applied: true, patchFile };
  } catch (err) {
    return { applied: false, error: err.message };
  }
}

/**
 * Verify a patch by re-hashing its diff and comparing against stored hash.
 *
 * @param {PatchData} patchData
 * @returns {{ verified: boolean, storedHash: string|null, computedHash: string|null }}
 */
function verifyPatch(patchData) {
  if (!patchData || typeof patchData.diff !== 'string') {
    return { verified: false, storedHash: null, computedHash: null };
  }
  const computedHash = hashDiff(patchData.diff);
  return {
    verified:     computedHash === patchData.hash,
    storedHash:   patchData.hash,
    computedHash,
  };
}

/**
 * Write a patch file to an output directory for distribution.
 *
 * @param {PatchData} patchData
 * @param {string}    outDir
 * @returns {string} path to written patch file
 */
function writePatchFile(patchData, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const fileName = `${patchData.pkgName}-${patchData.fromVersion}-to-${patchData.toVersion}.patch`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, patchData.diff, 'utf8');
  return filePath;
}

/**
 * Build patch metadata fragment for inclusion in an EvidenceBundle.
 *
 * @param {PatchData} patchData
 * @returns {object}
 */
function buildPatchEvidence(patchData) {
  return {
    patchHash:      patchData.hash,
    patchFrom:      patchData.fromVersion,
    patchTo:        patchData.toVersion,
    patchStatus:    patchData.status,
    patchCreatedAt: patchData.createdAt,
  };
}

module.exports = {
  PATCH_STATUS,
  hashDiff,
  createPatch,
  applyPatch,
  verifyPatch,
  writePatchFile,
  buildPatchEvidence,
};
