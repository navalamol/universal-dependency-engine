'use strict';

const semver = require('semver');

const REGISTRY_URL = 'https://search.maven.org/solrsearch/select';
const TIMEOUT_MS   = 10000;
// Maven Central rate-limits aggressive parallel requests; small sequential delay avoids 429s
const DELAY_MS     = 300;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch all published versions for a Maven artifact from Maven Central.
 * Returns null if the request fails (network error, unknown artifact).
 */
async function getPublishedVersions(groupId, artifactId) {
  const q = encodeURIComponent(`g:${groupId} AND a:${artifactId}`);
  const url = `${REGISTRY_URL}?q=${q}&core=gav&rows=200&wt=json`;
  const data = await fetchJson(url);
  if (!data || !data.response || !Array.isArray(data.response.docs)) return null;
  return data.response.docs.map(d => d.v).filter(Boolean);
}

/**
 * Verify that a recommended version exists on Maven Central and, if not, find the
 * nearest usable alternative within the same major version track.
 *
 * Same resolution rules as npm-registry.js:
 *   1. If recommendedVersion exists → use it as-is.
 *   2. Otherwise find the minimum published version that is:
 *      - Same major as recommendedVersion
 *      - >= recommendedVersion (still fixes the CVE)
 *   3. If no same-major candidate exists → return { exists: false }.
 */
async function resolveToAvailableVersion(groupId, artifactId, recommendedVersion) {
  const all = await getPublishedVersions(groupId, artifactId);

  if (!all) {
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

  return { version: recommendedVersion, exists: false, adjusted: false };
}

/**
 * Verify all items in a Maven resolution plan against Maven Central.
 * Returns the plan with { registryVersion, registryAdjusted, registryExists } added to each item.
 */
async function verifyPlanVersions(resolutionPlan) {
  process.stdout.write('  Checking Maven Central');

  const results = [];
  for (const item of resolutionPlan) {
    if (!item.recommendedVersion || !item.groupId) {
      results.push({ ...item, registryVersion: null, registryExists: false, registryAdjusted: false });
      process.stdout.write('.');
      continue;
    }

    const result = await resolveToAvailableVersion(item.groupId, item.libraryName, item.recommendedVersion);
    process.stdout.write('.');

    results.push({
      ...item,
      recommendedVersion: result.version,
      registryVersion:    result.version,
      registryExists:     result.exists,
      registryAdjusted:   result.adjusted,
      registryRequested:  result.requested,
    });

    await sleep(DELAY_MS);
  }

  process.stdout.write(' done\n');
  return results;
}

module.exports = { getPublishedVersions, resolveToAvailableVersion, verifyPlanVersions };
