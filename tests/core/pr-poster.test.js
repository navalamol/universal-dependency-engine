'use strict';

// Mock provider modules before requiring pr-poster so Jest intercepts the
// lazy require() calls inside openPR.
jest.mock('../../src/providers/github',      () => ({ createPR: jest.fn() }));
jest.mock('../../src/providers/gitlab',      () => ({ createMR: jest.fn() }));
jest.mock('../../src/providers/azuredevops', () => ({ createPR: jest.fn() }));
jest.mock('../../src/providers/bitbucket',   () => ({ createPR: jest.fn() }));

const childProcess = require('child_process');
const github      = require('../../src/providers/github');
const gitlab      = require('../../src/providers/gitlab');
const azuredevops = require('../../src/providers/azuredevops');
const bitbucket   = require('../../src/providers/bitbucket');

const {
  openPR, validateConfig, buildPRTitle, getCurrentBranch, PLATFORMS,
} = require('../../src/core/pr-poster');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makePhaseA(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    libraryName:       `pkg-${i}`,
    currentVersion:   '1.0.0',
    recommendedVersion: '1.0.1',
    phase:  'A',
    cves:   [{ id: `CVE-2024-${i}`, severity: 'HIGH', score: 7.5 }],
  }));
}

function baseConfig(platform, overrides = {}) {
  const loc = {
    github:      { githubOwner: 'myorg', githubRepo: 'myrepo' },
    gitlab:      { gitlabProjectId: '42' },
    azuredevops: { adoOrg: 'myorg', adoProject: 'myproject', adoRepoId: 'myrepo' },
    bitbucket:   { bitbucketWorkspace: 'myws', bitbucketRepoSlug: 'myrepo' },
  }[platform] || {};

  return {
    platform,
    token:        'test-token',
    sourceBranch: 'fix/security',
    targetBranch: 'main',
    title:        'fix: patch CVEs',
    body:         '## PR body',
    ...loc,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe('getCurrentBranch', () => {
  let spy;

  beforeEach(() => {
    spy = jest.spyOn(childProcess, 'spawnSync');
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('returns trimmed branch name on success', () => {
    spy.mockReturnValue({ status: 0, stdout: 'feature/fix-cves\n' });
    expect(getCurrentBranch()).toBe('feature/fix-cves');
  });

  test('returns null when status is non-zero', () => {
    spy.mockReturnValue({ status: 128, stdout: '' });
    expect(getCurrentBranch()).toBeNull();
  });

  test('returns null when stdout is empty', () => {
    spy.mockReturnValue({ status: 0, stdout: '' });
    expect(getCurrentBranch()).toBeNull();
  });

  test('returns null when detached HEAD', () => {
    spy.mockReturnValue({ status: 0, stdout: 'HEAD\n' });
    expect(getCurrentBranch()).toBeNull();
  });

  test('returns null when spawnSync throws', () => {
    spy.mockImplementation(() => { throw new Error('git not found'); });
    expect(getCurrentBranch()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPRTitle
// ---------------------------------------------------------------------------

describe('buildPRTitle', () => {
  test('counts total CVEs across all phases', () => {
    const plan = makePhaseA(3);
    const title = buildPRTitle(plan, 'npm');
    expect(title).toMatch(/3 CVEs/);
  });

  test('lists up to 3 package names', () => {
    const plan = makePhaseA(2);
    const title = buildPRTitle(plan, 'npm');
    expect(title).toContain('pkg-0');
    expect(title).toContain('pkg-1');
    expect(title).not.toContain('+');
  });

  test('shows "+N more" when more than 3 packages', () => {
    const plan = makePhaseA(6);
    const title = buildPRTitle(plan, 'npm');
    expect(title).toContain('+3 more');
  });

  test('includes ecosystem prefix for non-npm', () => {
    const plan = makePhaseA(1);
    const title = buildPRTitle(plan, 'maven');
    expect(title).toContain('[maven]');
  });

  test('omits ecosystem prefix for npm', () => {
    const plan = makePhaseA(1);
    const title = buildPRTitle(plan, 'npm');
    expect(title).not.toContain('[npm]');
  });

  test('handles empty plan', () => {
    const title = buildPRTitle([], 'npm');
    expect(title).toMatch(/0 CVEs/);
  });

  test('uses singular "CVE" for exactly one', () => {
    const plan = makePhaseA(1);
    // 1 item, 1 CVE each
    const title = buildPRTitle(plan, 'npm');
    expect(title).toMatch(/1 CVE[^s]/);
  });

  test('includes Phase B items in package list', () => {
    const plan = [
      { libraryName: 'lodash', phase: 'A', cves: [{ id: 'CVE-1', severity: 'HIGH', score: 7 }], currentVersion: '4.0.0', recommendedVersion: '4.17.21' },
      { libraryName: 'express', phase: 'B', cves: [{ id: 'CVE-2', severity: 'MEDIUM', score: 5 }], currentVersion: '4.0.0', recommendedVersion: '4.18.0' },
    ];
    const title = buildPRTitle(plan, 'npm');
    expect(title).toContain('lodash');
    expect(title).toContain('express');
  });
});

// ---------------------------------------------------------------------------
// PLATFORMS export
// ---------------------------------------------------------------------------

describe('PLATFORMS', () => {
  test('exports the four platform names', () => {
    expect(PLATFORMS).toEqual(['github', 'gitlab', 'azuredevops', 'bitbucket']);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig — missing platform', () => {
  test('returns error when platform is absent', () => {
    const errs = validateConfig({});
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/platform is required/);
  });

  test('returns error for unknown platform', () => {
    const errs = validateConfig({ platform: 'jenkins' });
    expect(errs[0]).toMatch(/unknown platform/);
  });
});

describe('validateConfig — common required fields', () => {
  test('error when token is missing', () => {
    const cfg = baseConfig('github', { token: undefined });
    const errs = validateConfig(cfg);
    expect(errs.some(e => /token is required/.test(e))).toBe(true);
  });

  test('error when sourceBranch is missing', () => {
    const cfg = baseConfig('github', { sourceBranch: undefined });
    const errs = validateConfig(cfg);
    expect(errs.some(e => /sourceBranch is required/.test(e))).toBe(true);
  });
});

describe('validateConfig — GitHub', () => {
  test('passes with all required fields', () => {
    expect(validateConfig(baseConfig('github'))).toHaveLength(0);
  });

  test('error when githubOwner is missing', () => {
    const errs = validateConfig(baseConfig('github', { githubOwner: undefined }));
    expect(errs.some(e => /githubOwner/.test(e))).toBe(true);
  });

  test('error when githubRepo is missing', () => {
    const errs = validateConfig(baseConfig('github', { githubRepo: undefined }));
    expect(errs.some(e => /githubRepo/.test(e))).toBe(true);
  });
});

describe('validateConfig — GitLab', () => {
  test('passes with all required fields', () => {
    expect(validateConfig(baseConfig('gitlab'))).toHaveLength(0);
  });

  test('error when gitlabProjectId is missing', () => {
    const errs = validateConfig(baseConfig('gitlab', { gitlabProjectId: undefined }));
    expect(errs.some(e => /gitlabProjectId/.test(e))).toBe(true);
  });
});

describe('validateConfig — Azure DevOps', () => {
  test('passes with all required fields', () => {
    expect(validateConfig(baseConfig('azuredevops'))).toHaveLength(0);
  });

  test('error when adoOrg is missing', () => {
    const errs = validateConfig(baseConfig('azuredevops', { adoOrg: undefined }));
    expect(errs.some(e => /adoOrg/.test(e))).toBe(true);
  });

  test('error when adoProject is missing', () => {
    const errs = validateConfig(baseConfig('azuredevops', { adoProject: undefined }));
    expect(errs.some(e => /adoProject/.test(e))).toBe(true);
  });

  test('error when adoRepoId is missing', () => {
    const errs = validateConfig(baseConfig('azuredevops', { adoRepoId: undefined }));
    expect(errs.some(e => /adoRepoId/.test(e))).toBe(true);
  });
});

describe('validateConfig — Bitbucket', () => {
  test('passes with all required fields', () => {
    expect(validateConfig(baseConfig('bitbucket'))).toHaveLength(0);
  });

  test('error when bitbucketWorkspace is missing', () => {
    const errs = validateConfig(baseConfig('bitbucket', { bitbucketWorkspace: undefined }));
    expect(errs.some(e => /bitbucketWorkspace/.test(e))).toBe(true);
  });

  test('error when bitbucketRepoSlug is missing', () => {
    const errs = validateConfig(baseConfig('bitbucket', { bitbucketRepoSlug: undefined }));
    expect(errs.some(e => /bitbucketRepoSlug/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openPR — validation short-circuit
// ---------------------------------------------------------------------------

describe('openPR — validation errors', () => {
  test('returns {ok:false} without calling provider when config is invalid', async () => {
    github.createPR.mockClear();
    const result = await openPR({ platform: 'github', token: 'tok', sourceBranch: 'fix' /* no owner/repo */ });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(github.createPR).not.toHaveBeenCalled();
  });

  test('returns {ok:false} when platform is missing', async () => {
    const result = await openPR({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/platform is required/);
  });
});

// ---------------------------------------------------------------------------
// openPR — GitHub dispatch
// ---------------------------------------------------------------------------

describe('openPR — GitHub', () => {
  beforeEach(() => github.createPR.mockReset());

  test('calls createPR with correct args', async () => {
    github.createPR.mockResolvedValue({ ok: true, status: 201, data: { number: 42, html_url: 'https://github.com/myorg/myrepo/pull/42' } });
    await openPR(baseConfig('github'));
    expect(github.createPR).toHaveBeenCalledWith(
      'myorg', 'myrepo', 'test-token',
      expect.objectContaining({ head: 'fix/security', base: 'main', title: 'fix: patch CVEs' })
    );
  });

  test('returns {ok, url, id, platform} on success', async () => {
    github.createPR.mockResolvedValue({ ok: true, status: 201, data: { number: 7, html_url: 'https://github.com/o/r/pull/7' } });
    const result = await openPR(baseConfig('github'));
    expect(result).toMatchObject({ ok: true, platform: 'github', url: 'https://github.com/o/r/pull/7', id: 7 });
  });

  test('returns {ok:false} when API returns non-ok status', async () => {
    github.createPR.mockResolvedValue({ ok: false, status: 422, data: { message: 'Validation Failed' } });
    const result = await openPR(baseConfig('github'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Validation Failed');
  });

  test('returns {ok:false} when createPR throws', async () => {
    github.createPR.mockRejectedValue(new Error('network error'));
    const result = await openPR(baseConfig('github'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network error');
  });

  test('forwards draft flag', async () => {
    github.createPR.mockResolvedValue({ ok: true, status: 201, data: { number: 1, html_url: 'https://github.com/o/r/pull/1' } });
    await openPR(baseConfig('github', { draft: true }));
    expect(github.createPR).toHaveBeenCalledWith('myorg', 'myrepo', 'test-token',
      expect.objectContaining({ draft: true }));
  });
});

// ---------------------------------------------------------------------------
// openPR — GitLab dispatch
// ---------------------------------------------------------------------------

describe('openPR — GitLab', () => {
  beforeEach(() => gitlab.createMR.mockReset());

  test('calls createMR with correct args', async () => {
    gitlab.createMR.mockResolvedValue({ ok: true, status: 201, data: { iid: 5, web_url: 'https://gitlab.com/myorg/myrepo/-/merge_requests/5' } });
    await openPR(baseConfig('gitlab'));
    expect(gitlab.createMR).toHaveBeenCalledWith(
      '42', 'test-token',
      expect.objectContaining({ sourceBranch: 'fix/security', targetBranch: 'main', title: 'fix: patch CVEs' }),
      undefined   // no baseUrl
    );
  });

  test('returns {ok, url, id} on success', async () => {
    gitlab.createMR.mockResolvedValue({ ok: true, status: 201, data: { iid: 5, web_url: 'https://gitlab.com/x/y/-/merge_requests/5' } });
    const result = await openPR(baseConfig('gitlab'));
    expect(result).toMatchObject({ ok: true, platform: 'gitlab', url: 'https://gitlab.com/x/y/-/merge_requests/5', id: 5 });
  });

  test('forwards gitlabBaseUrl when provided', async () => {
    gitlab.createMR.mockResolvedValue({ ok: true, status: 201, data: { iid: 1, web_url: 'https://git.example.com/mr/1' } });
    await openPR(baseConfig('gitlab', { gitlabBaseUrl: 'https://git.example.com' }));
    expect(gitlab.createMR).toHaveBeenCalledWith('42', 'test-token', expect.anything(), 'https://git.example.com');
  });

  test('returns {ok:false} on API error', async () => {
    gitlab.createMR.mockResolvedValue({ ok: false, status: 409, data: { message: 'Another open merge request already exists' } });
    const result = await openPR(baseConfig('gitlab'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Another open merge request');
  });

  test('handles array error message from GitLab', async () => {
    gitlab.createMR.mockResolvedValue({ ok: false, status: 422, data: ['source_branch is invalid', 'target_branch cannot be empty'] });
    const result = await openPR(baseConfig('gitlab'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('source_branch is invalid');
  });
});

// ---------------------------------------------------------------------------
// openPR — Azure DevOps dispatch
// ---------------------------------------------------------------------------

describe('openPR — Azure DevOps', () => {
  beforeEach(() => azuredevops.createPR.mockReset());

  test('calls createPR with correct args', async () => {
    azuredevops.createPR.mockResolvedValue({
      ok: true, status: 201,
      data: { pullRequestId: 99, webUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/99' },
    });
    await openPR(baseConfig('azuredevops'));
    expect(azuredevops.createPR).toHaveBeenCalledWith(
      'myorg', 'myproject', 'myrepo', 'test-token',
      expect.objectContaining({ sourceBranch: 'fix/security', targetBranch: 'main', title: 'fix: patch CVEs' })
    );
  });

  test('returns {ok, url, id} on success', async () => {
    azuredevops.createPR.mockResolvedValue({
      ok: true, status: 201,
      data: { pullRequestId: 99, webUrl: 'https://dev.azure.com/o/p/_git/r/pullrequest/99' },
    });
    const result = await openPR(baseConfig('azuredevops'));
    expect(result).toMatchObject({ ok: true, platform: 'azuredevops', id: 99 });
    expect(result.url).toContain('pullrequest/99');
  });

  test('returns {ok:false} on API error', async () => {
    azuredevops.createPR.mockResolvedValue({ ok: false, status: 400, data: { message: 'TF400898: An Internal Error Occurred' } });
    const result = await openPR(baseConfig('azuredevops'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TF400898');
  });
});

// ---------------------------------------------------------------------------
// openPR — Bitbucket dispatch
// ---------------------------------------------------------------------------

describe('openPR — Bitbucket', () => {
  beforeEach(() => bitbucket.createPR.mockReset());

  test('calls createPR with correct args', async () => {
    bitbucket.createPR.mockResolvedValue({
      ok: true, status: 201,
      data: { id: 3, links: { html: { href: 'https://bitbucket.org/myws/myrepo/pull-requests/3' } } },
    });
    await openPR(baseConfig('bitbucket'));
    expect(bitbucket.createPR).toHaveBeenCalledWith(
      'myws', 'myrepo', 'test-token',
      expect.objectContaining({ sourceBranch: 'fix/security', targetBranch: 'main', title: 'fix: patch CVEs' })
    );
  });

  test('returns {ok, url, id} on success', async () => {
    bitbucket.createPR.mockResolvedValue({
      ok: true, status: 201,
      data: { id: 3, links: { html: { href: 'https://bitbucket.org/w/r/pull-requests/3' } } },
    });
    const result = await openPR(baseConfig('bitbucket'));
    expect(result).toMatchObject({ ok: true, platform: 'bitbucket', id: 3 });
    expect(result.url).toContain('pull-requests/3');
  });

  test('returns {ok:false} on API error', async () => {
    bitbucket.createPR.mockResolvedValue({
      ok: false, status: 400,
      data: { error: { message: 'source branch does not exist' } },
    });
    const result = await openPR(baseConfig('bitbucket'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('source branch does not exist');
  });

  test('handles missing links.html gracefully', async () => {
    bitbucket.createPR.mockResolvedValue({ ok: true, status: 201, data: { id: 5, links: {} } });
    const result = await openPR(baseConfig('bitbucket'));
    expect(result.ok).toBe(true);
    expect(result.url).toBeNull();
    expect(result.id).toBe(5);
  });
});
