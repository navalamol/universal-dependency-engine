'use strict';

const semver = require('semver');

const PYPI_URL   = 'https://pypi.org/pypi';
const TIMEOUT_MS = 10000;

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
 * Fetch all published versions for a PyPI package.
 * Returns null on network failure or unknown package.
 */
async function getPublishedVersions(name) {
  const data = await fetchJson(`${PYPI_URL}/${encodeURIComponent(name)}/json`);
  if (!data || !data.releases) return null;
  return Object.keys(data.releases).filter(v => semver.valid(semver.coerce(v)));
}

/**
 * Verify that a recommended version exists on PyPI and, if not, find the
 * nearest usable alternative within the same major version track.
 */
async function resolveToAvailableVersion(name, recommendedVersion) {
  const all = await getPublishedVersions(name);

  if (!all) {
    return { version: recommendedVersion, exists: null, adjusted: false };
  }

  if (all.includes(recommendedVersion)) {
    return { version: recommendedVersion, exists: true, adjusted: false };
  }

  const coerced = semver.coerce(recommendedVersion);
  if (!coerced) {
    return { version: recommendedVersion, exists: false, adjusted: false };
  }
  const major = coerced.major;

  const candidates = all
    .map(v => ({ raw: v, sem: semver.coerce(v) }))
    .filter(({ sem }) => sem && sem.major === major && semver.gte(sem, coerced))
    .sort((a, b) => semver.compare(a.sem, b.sem));

  if (candidates.length > 0) {
    return {
      version:   candidates[0].raw,
      exists:    true,
      adjusted:  true,
      requested: recommendedVersion,
    };
  }

  return { version: recommendedVersion, exists: false, adjusted: false };
}

/**
 * Verify all Python items in a resolution plan against PyPI.
 */
async function verifyPlanVersions(resolutionPlan) {
  process.stdout.write('  Checking PyPI');

  const results = [];
  for (const item of resolutionPlan) {
    if (!item.recommendedVersion) {
      results.push({ ...item, registryVersion: null, registryExists: false, registryAdjusted: false });
      process.stdout.write('.');
      continue;
    }

    const result = await resolveToAvailableVersion(item.libraryName, item.recommendedVersion);
    process.stdout.write('.');

    results.push({
      ...item,
      recommendedVersion: result.version,
      registryVersion:    result.version,
      registryExists:     result.exists,
      registryAdjusted:   result.adjusted,
      registryRequested:  result.requested,
    });
  }

  process.stdout.write(' done\n');
  return results;
}

module.exports = { getPublishedVersions, resolveToAvailableVersion, verifyPlanVersions };
