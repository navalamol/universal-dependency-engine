'use strict';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 15000;

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mendfix-renovate-workflow',
  };
}

async function apiRequest(method, path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const opts = {
      method,
      headers: authHeaders(token),
      signal: controller.signal,
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${GITHUB_API}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all open PRs authored by renovate[bot] or renovate for a repo.
 * Paginates automatically.
 */
async function fetchRenovatePRs(org, repo, token) {
  const renovateBots = new Set(['renovate[bot]', 'renovate', 'renovate-bot']);
  const prs = [];
  let page = 1;

  while (true) {
    const { ok, data } = await apiRequest(
      'GET',
      `/repos/${org}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      token
    );
    if (!ok || !Array.isArray(data)) break;
    if (data.length === 0) break;

    for (const pr of data) {
      const login = (pr.user && pr.user.login) ? pr.user.login.toLowerCase() : '';
      if (renovateBots.has(login)) {
        prs.push({
          number: pr.number,
          title: pr.title,
          html_url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          labels: (pr.labels || []).map(l => l.name),
          headRef: pr.head && pr.head.ref,
        });
      }
    }

    if (data.length < 100) break;
    page++;
  }

  return prs;
}

/**
 * Post a comment on a PR (uses the issues comments endpoint, which works for PRs).
 */
async function postComment(org, repo, prNumber, token, body) {
  return apiRequest('POST', `/repos/${org}/${repo}/issues/${prNumber}/comments`, token, { body });
}

/**
 * Close a PR.
 */
async function closePR(org, repo, prNumber, token) {
  return apiRequest('PATCH', `/repos/${org}/${repo}/pulls/${prNumber}`, token, { state: 'closed' });
}

/**
 * Create a pull request.
 * opts: { title, body, head, base?, draft? }
 * Returns { ok, status, data: { number, html_url } }
 */
async function createPR(owner, repo, token, opts) {
  const { title, body, head, base = 'main', draft = false } = opts;
  return apiRequest('POST', `/repos/${owner}/${repo}/pulls`, token, {
    title, body, head, base, draft,
  });
}

module.exports = { fetchRenovatePRs, postComment, closePR, createPR };
