'use strict';

const semver = require('semver');

// crates.io API — rate limit is 1 req/s; use sequential calls without extra delay
// since registry verification is already sequential.
const CRATES_URL = 'https://crates.io/api/v1/crates';
const TIMEOUT_MS = 10000;
// crates.io requires a User-Agent identifying the application
const USER_AGENT = 'mendfix-autofixer/1.0 (https://github.com/your-org/mendfix)';

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all published versions for a crate from crates.io.
 * Returns an array of version strings, or null on error.
 */
async function getPublishedVersions(name) {
  const data = await fetchJson(`${CRATES_URL}/${encodeURIComponent(name)}/versions`);
  if (!data || !Array.isArray(data.versions)) return null;
  return data.versions
    .filter(v => !v.yanked)
    .map(v => v.num)
    .filter(v => semver.valid(semver.coerce(v)));
}

/**
 * Verify that a recommended version exists on crates.io and, if not, find the
 * nearest usable alternative within the same major version track.
 */
async function resolveToAvailableVersion(name, recommendedVersion) {
  const all = await getPublishedVersions(name);

  if (!all) return { version: recommendedVersion, exists: null, adjusted: false };

  if (all.includes(recommendedVersion)) {
    return { version: recommendedVersion, exists: true, adjusted: false };
  }

  const coerced = semver.coerce(recommendedVersion);
  if (!coerced) return { version: recommendedVersion, exists: false, adjusted: false };
  const major = coerced.major;

  const candidates = all
    .map(v => ({ raw: v, sem: semver.coerce(v) }))
    .filter(({ sem }) => sem && sem.major === major && semver.gte(sem, coerced))
    .sort((a, b) => semver.compare(a.sem, b.sem));

  if (candidates.length > 0) {
    return { version: candidates[0].raw, exists: true, adjusted: true, requested: recommendedVersion };
  }

  return { version: recommendedVersion, exists: false, adjusted: false };
}

/**
 * Verify all Rust items in a resolution plan against crates.io.
 */
async function verifyPlanVersions(resolutionPlan) {
  process.stdout.write('  Checking crates.io');

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
    // crates.io rate limit: 1 req/s
    await new Promise(r => setTimeout(r, 1000));
  }

  process.stdout.write(' done\n');
  return results;
}

module.exports = { getPublishedVersions, resolveToAvailableVersion, verifyPlanVersions };
