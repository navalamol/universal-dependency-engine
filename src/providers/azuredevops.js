'use strict';

// Azure DevOps REST API — PR creation and comment write-back.
//
// Auth: Personal Access Token (PAT).  The API uses HTTP Basic auth with an
// empty username and the PAT as the password: base64(':' + pat).
//
// API version targeted: 7.1

const ADO_API_VERSION = '7.1';
const TIMEOUT_MS = 15000;

function azdoHeaders(token) {
  const encoded = Buffer.from(`:${token}`).toString('base64');
  return {
    'Authorization': `Basic ${encoded}`,
    'Content-Type': 'application/json',
    'User-Agent': 'mendfix-azuredevops-writeback',
  };
}

async function azdoRequest(method, url, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const opts = {
      method,
      headers: azdoHeaders(token),
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function reposBase(org, project, repoId) {
  const encoded = encodeURIComponent(project);
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encoded}/_apis/git/repositories/${encodeURIComponent(repoId)}`;
}

/**
 * Create a pull request in an Azure DevOps Git repository.
 * org:    Azure DevOps organisation name
 * project: team project name or GUID
 * repoId: repository name or GUID
 * token:  Personal Access Token with Code (Read & Write) scope
 * opts: { title, description?, sourceBranch, targetBranch? }
 *   sourceBranch / targetBranch should be short names (e.g. "fix/cve-2024")
 *   — refs/heads/ prefix is added automatically.
 * Returns { ok, status, data: { pullRequestId, webUrl } }
 */
async function createPR(org, project, repoId, token, opts) {
  const {
    title,
    description = '',
    sourceBranch,
    targetBranch = 'main',
  } = opts;
  const url = `${reposBase(org, project, repoId)}/pullrequests?api-version=${ADO_API_VERSION}`;
  const result = await azdoRequest('POST', url, token, {
    title,
    description,
    sourceRefName: `refs/heads/${sourceBranch}`,
    targetRefName: `refs/heads/${targetBranch}`,
  });
  // Flatten webUrl out of _links for convenience
  if (result.ok && result.data) {
    result.data.webUrl = (result.data._links && result.data._links.web && result.data._links.web.href) || null;
  }
  return result;
}

/**
 * Post a comment thread on a pull request.
 * prId: pullRequestId returned by createPR (or fetched from the API).
 * body: plain text or markdown string.
 * Returns { ok, status, data }
 */
async function addComment(org, project, repoId, prId, token, body) {
  const url = `${reposBase(org, project, repoId)}/pullrequests/${prId}/threads?api-version=${ADO_API_VERSION}`;
  return azdoRequest('POST', url, token, {
    comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
    status: 1,
  });
}

module.exports = { createPR, addComment };
