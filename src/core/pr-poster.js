'use strict';

const childProcess = require('child_process');

const PLATFORMS = ['github', 'gitlab', 'azuredevops', 'bitbucket'];

/**
 * Detect the current git branch name.
 * Returns null if git is unavailable or the working directory is not a repo.
 */
function getCurrentBranch() {
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const branch = result.stdout.trim();
      return branch && branch !== 'HEAD' ? branch : null;
    }
  } catch {}
  return null;
}

/**
 * Build a PR title from the phased plan.
 * Format: "fix(security): patch N CVEs [ecosystem] — pkg1, pkg2 (+N more)"
 */
function buildPRTitle(phasedPlan, ecosystem) {
  const fixed = phasedPlan.filter(i => i.phase === 'A' || i.phase === 'B');
  const totalCves = phasedPlan.reduce((n, i) => n + (i.cves || []).length, 0);

  let pkgList = '';
  if (fixed.length > 0) {
    const names  = fixed.map(i => i.libraryName);
    const shown  = names.slice(0, 3).join(', ');
    const extra  = names.length > 3 ? ` (+${names.length - 3} more)` : '';
    pkgList = ` — ${shown}${extra}`;
  }

  const eco = ecosystem && ecosystem !== 'npm' ? ` [${ecosystem}]` : '';
  return `fix(security): patch ${totalCves} CVE${totalCves !== 1 ? 's' : ''}${eco}${pkgList}`;
}

/**
 * Validate a PR config object.
 * Returns an array of error strings. Empty array = valid.
 */
function validateConfig(config) {
  const errors = [];
  const { platform } = config || {};

  if (!platform) {
    errors.push('platform is required (github | gitlab | azuredevops | bitbucket)');
    return errors;
  }
  if (!PLATFORMS.includes(platform)) {
    errors.push(`unknown platform "${platform}" — valid values: ${PLATFORMS.join(', ')}`);
    return errors;
  }

  const ENV_NAMES = {
    github:      'GITHUB_TOKEN',
    gitlab:      'GITLAB_TOKEN',
    azuredevops: 'AZURE_DEVOPS_TOKEN',
    bitbucket:   'BITBUCKET_TOKEN',
  };
  if (!config.token) {
    errors.push(`token is required for ${platform} (pass --${platform === 'azuredevops' ? 'ado' : platform}-token or set ${ENV_NAMES[platform]})`);
  }
  if (!config.sourceBranch) {
    errors.push('sourceBranch is required (use --pr-branch or ensure a git branch is checked out)');
  }

  if (platform === 'github') {
    if (!config.githubOwner) errors.push('githubOwner is required for GitHub (--github-owner)');
    if (!config.githubRepo)  errors.push('githubRepo is required for GitHub (--github-repo)');
  } else if (platform === 'gitlab') {
    if (!config.gitlabProjectId) errors.push('gitlabProjectId is required for GitLab (--gitlab-project-id)');
  } else if (platform === 'azuredevops') {
    if (!config.adoOrg)     errors.push('adoOrg is required for Azure DevOps (--ado-org)');
    if (!config.adoProject) errors.push('adoProject is required for Azure DevOps (--ado-project)');
    if (!config.adoRepoId)  errors.push('adoRepoId is required for Azure DevOps (--ado-repo-id)');
  } else if (platform === 'bitbucket') {
    if (!config.bitbucketWorkspace) errors.push('bitbucketWorkspace is required for Bitbucket (--bitbucket-workspace)');
    if (!config.bitbucketRepoSlug)  errors.push('bitbucketRepoSlug is required for Bitbucket (--bitbucket-repo-slug)');
  }

  return errors;
}

/**
 * Create a PR/MR on the configured CI/CD platform.
 *
 * config shape:
 *   platform:             'github' | 'gitlab' | 'azuredevops' | 'bitbucket'
 *   token:                string
 *   sourceBranch:         string   (head/source branch — must be pushed already)
 *   targetBranch:         string   (default: 'main')
 *   title:                string
 *   body:                 string   (markdown PR description)
 *   draft:                boolean  (GitHub only, default: false)
 *   githubOwner:          string   (GitHub)
 *   githubRepo:           string   (GitHub)
 *   gitlabProjectId:      string   (GitLab — numeric id or namespace/path)
 *   gitlabBaseUrl:        string   (GitLab — optional, default https://gitlab.com)
 *   adoOrg:               string   (Azure DevOps)
 *   adoProject:           string   (Azure DevOps)
 *   adoRepoId:            string   (Azure DevOps — repo name or GUID)
 *   bitbucketWorkspace:   string   (Bitbucket)
 *   bitbucketRepoSlug:    string   (Bitbucket)
 *
 * Returns: { ok, platform, url, id, error? }
 */
async function openPR(config) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return { ok: false, platform: config && config.platform, url: null, id: null, error: errors.join('; ') };
  }

  const {
    platform, token,
    sourceBranch, targetBranch = 'main',
    title, body, draft = false,
  } = config;

  try {
    if (platform === 'github') {
      const { createPR } = require('../providers/github');
      const res = await createPR(config.githubOwner, config.githubRepo, token, {
        title, body, head: sourceBranch, base: targetBranch, draft,
      });
      if (!res.ok) {
        const msg = (res.data && res.data.message) || `HTTP ${res.status}`;
        return { ok: false, platform, url: null, id: null, error: msg };
      }
      return { ok: true, platform, url: res.data.html_url, id: res.data.number };

    } else if (platform === 'gitlab') {
      const { createMR } = require('../providers/gitlab');
      const res = await createMR(config.gitlabProjectId, token, {
        title, description: body, sourceBranch, targetBranch,
      }, config.gitlabBaseUrl);
      if (!res.ok) {
        const msg = (res.data && (res.data.message || (Array.isArray(res.data) && res.data.join(', ')))) || `HTTP ${res.status}`;
        return { ok: false, platform, url: null, id: null, error: msg };
      }
      return { ok: true, platform, url: res.data.web_url, id: res.data.iid };

    } else if (platform === 'azuredevops') {
      const { createPR } = require('../providers/azuredevops');
      const res = await createPR(config.adoOrg, config.adoProject, config.adoRepoId, token, {
        title, description: body, sourceBranch, targetBranch,
      });
      if (!res.ok) {
        const msg = (res.data && res.data.message) || `HTTP ${res.status}`;
        return { ok: false, platform, url: null, id: null, error: msg };
      }
      return { ok: true, platform, url: res.data.webUrl || null, id: res.data.pullRequestId };

    } else if (platform === 'bitbucket') {
      const { createPR } = require('../providers/bitbucket');
      const res = await createPR(config.bitbucketWorkspace, config.bitbucketRepoSlug, token, {
        title, description: body, sourceBranch, targetBranch,
      });
      if (!res.ok) {
        const msg = (res.data && res.data.error && res.data.error.message) || `HTTP ${res.status}`;
        return { ok: false, platform, url: null, id: null, error: msg };
      }
      const url = res.data.links && res.data.links.html && res.data.links.html.href || null;
      return { ok: true, platform, url, id: res.data.id };
    }
  } catch (err) {
    return { ok: false, platform, url: null, id: null, error: err.message };
  }

  return { ok: false, platform, url: null, id: null, error: 'unreachable — unknown platform' };
}

module.exports = { openPR, validateConfig, buildPRTitle, getCurrentBranch, PLATFORMS };
