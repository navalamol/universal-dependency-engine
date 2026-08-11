'use strict';

const semver = require('semver');

const REGISTRY_URL = 'https://registry.npmjs.org';
const TIMEOUT_MS   = 8000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all published versions for a package from npm registry.
 * Returns null if the request fails (network error, unknown package).
 */
async function getPublishedVersions(packageName) {
  // Use the abbreviated metadata endpoint (much smaller payload than full registry doc)
  const data = await fetchJson(`${REGISTRY_URL}/${encodeURIComponent(packageName)}`);
  if (!data || !data.versions) return null;
  return Object.keys(data.versions);
}

/**
 * Verify that a recommended version exists on npm and, if not, find the
 * nearest usable alternative within the same major version track.
 *
 * Resolution rules (in order):
 *   1. If recommendedVersion exists → use it as-is.
 *   2. Otherwise find the minimum published version that is:
 *      - Same major as recommendedVersion
 *      - >= recommendedVersion (still fixes the CVE)
 *   3. If no same-major candidate exists → return { exists: false } so the
 *      caller can escalate to Phase C (cross-major fallback).
 *
 * Returns:
 *   { version, exists, adjusted, requested? }
 *     exists   — true if the returned version is confirmed published
 *     adjusted — true if we had to pick a different version than requested
 *     requested — original recommendedVersion when adjusted is true
 */
async function resolveToAvailableVersion(packageName, recommendedVersion) {
  const all = await getPublishedVersions(packageName);

  if (!all) {
    // Registry unreachable — pass through without verification
    return { version: recommendedVersion, exists: null, adjusted: false };
  }

  if (all.includes(recommendedVersion)) {
    return { version: recommendedVersion, exists: true, adjusted: false };
  }

  const major = semver.major(recommendedVersion);
  const candidates = all
    .filter(v => semver.valid(v) && semver.major(v) === major && semver.gte(v, recommendedVersion))
    .sort(semver.compare);

  if (candidates.length > 0) {
    return {
      version:   candidates[0],
      exists:    true,
      adjusted:  true,
      requested: recommendedVersion,
    };
  }

  // No published version in this major track satisfies the minimum fix requirement
  return { version: recommendedVersion, exists: false, adjusted: false };
}

/**
 * Verify all items in a resolution plan against the npm registry.
 * Returns the plan with { registryVersion, registryAdjusted, registryExists } added to each item.
 */
async function verifyPlanVersions(resolutionPlan) {
  process.stdout.write('  Checking npm registry');

  const results = await Promise.all(
    resolutionPlan.map(async item => {
      if (!item.recommendedVersion) {
        return { ...item, registryVersion: null, registryExists: false, registryAdjusted: false };
      }

      const result = await resolveToAvailableVersion(item.libraryName, item.recommendedVersion);
      process.stdout.write('.');

      return {
        ...item,
        recommendedVersion: result.version,
        registryVersion:    result.version,
        registryExists:     result.exists,
        registryAdjusted:   result.adjusted,
        registryRequested:  result.requested,
      };
    })
  );

  process.stdout.write(' done\n');
  return results;
}

module.exports = { getPublishedVersions, resolveToAvailableVersion, verifyPlanVersions };
