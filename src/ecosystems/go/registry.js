'use strict';

const semver = require('semver');

// Go module proxy — the canonical source for available versions.
// Uses the GOPROXY env var if set (common in CI); falls back to the public proxy.
const PROXY_BASE  = (typeof process !== 'undefined' && process.env.GOPROXY)
  ? process.env.GOPROXY.split(',')[0].replace(/\/$/, '')
  : 'https://proxy.golang.org';
const TIMEOUT_MS  = 10000;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return all published versions for a Go module path.
 * proxy.golang.org/MODULE/@v/list returns one version per line.
 */
async function getPublishedVersions(modulePath) {
  const encoded = encodeGoModule(modulePath);
  const text    = await fetchText(`${PROXY_BASE}/${encoded}/@v/list`);
  if (!text) return null;
  return text.trim().split('\n').filter(Boolean).map(v => v.replace(/^v/, ''));
}

/**
 * Encode a Go module path for use in a proxy URL (capital letters → !lowercase).
 */
function encodeGoModule(modulePath) {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

/**
 * Verify that a recommended version exists on the Go module proxy and, if not,
 * find the nearest usable alternative within the same major version track.
 */
async function resolveToAvailableVersion(modulePath, recommendedVersion) {
  const all = await getPublishedVersions(modulePath);

  if (!all) {
    return { version: recommendedVersion, exists: null, adjusted: false };
  }

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
 * Verify all Go items in a resolution plan against the Go module proxy.
 */
async function verifyPlanVersions(resolutionPlan) {
  process.stdout.write('  Checking Go module proxy');

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

module.exports = { getPublishedVersions, resolveToAvailableVersion, verifyPlanVersions, encodeGoModule };
