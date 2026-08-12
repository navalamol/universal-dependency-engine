'use strict';

// Bitbucket Cloud REST API v2 — PR creation and comment write-back.
//
// Auth: pass token as "username:app_password".  The colon is the separator;
// the function detects it and uses HTTP Basic auth.  If the token contains
// no colon it is sent as a Bearer token (Bitbucket repository access tokens,
// introduced 2024).
//
// Bitbucket Server / Data Center uses a different host and auth header
// (X-Auth-Token).  Pass opts.serverMode = true + a non-cloud baseUrl to
// enable server mode.

const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const TIMEOUT_MS = 15000;

function bbHeaders(token, serverMode = false) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'mendfix-bitbucket-writeback',
  };
  if (serverMode) {
    // Bitbucket Server: PAT sent as bearer
    headers['Authorization'] = `Bearer ${token}`;
  } else if (token.includes(':')) {
    // Cloud: username:app_password → Basic auth
    headers['Authorization'] = `Basic ${Buffer.from(token).toString('base64')}`;
  } else {
    // Cloud: repository access token
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function bbRequest(method, baseUrl, path, token, body, serverMode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const opts = {
      method,
      headers: bbHeaders(token, serverMode),
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Bitbucket Cloud pull request.
 * workspace: Bitbucket workspace slug
 * repoSlug:  repository slug
 * token:     "username:app_password" or a repository access token (Bearer)
 * opts: { title, description?, sourceBranch, targetBranch?, reviewers? }
 *   reviewers: array of account UUIDs: ['{uuid}', ...]
 * Returns { ok, status, data: { id, links.html.href } }
 */
async function createPR(workspace, repoSlug, token, opts) {
  const {
    title,
    description = '',
    sourceBranch,
    targetBranch = 'main',
    reviewers = [],
  } = opts;

  const body = {
    title,
    description,
    source: { branch: { name: sourceBranch } },
    destination: { branch: { name: targetBranch } },
    close_source_branch: true,
  };
  if (reviewers.length) {
    body.reviewers = reviewers.map(uuid => ({ uuid }));
  }

  return bbRequest('POST', BITBUCKET_API, `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests`, token, body, false);
}

/**
 * Post a comment on a Bitbucket Cloud pull request.
 * prId: pull request id (number) returned by createPR or fetched from API.
 * Returns { ok, status, data }
 */
async function addComment(workspace, repoSlug, prId, token, body) {
  return bbRequest(
    'POST',
    BITBUCKET_API,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/comments`,
    token,
    { content: { raw: body } },
    false
  );
}

module.exports = { createPR, addComment };
