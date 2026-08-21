'use strict';

const { generateWorkflow, generateAzureDevOpsPipeline } = require('../../src/ci/github-actions');

// ─── generateWorkflow ─────────────────────────────────────────────────────────

test('generateWorkflow returns a non-empty string', () => {
  const yaml = generateWorkflow();
  expect(typeof yaml).toBe('string');
  expect(yaml.length).toBeGreaterThan(0);
});

test('generateWorkflow default is dry-run mode (no apply step)', () => {
  const yaml = generateWorkflow();
  // Default: only analyze step, no apply step
  expect(yaml).not.toContain('mendfix.js apply');
  expect(yaml).toContain('mendfix.js analyze');
});

test('generateWorkflow contains least-privilege permissions: read only by default', () => {
  const yaml = generateWorkflow();
  expect(yaml).toContain('contents: read');
  expect(yaml).not.toContain('contents: write');
});

test('generateWorkflow with enableApply adds apply step', () => {
  const yaml = generateWorkflow({ enableApply: true });
  expect(yaml).toContain('apply');
});

test('generateWorkflow with enableApply + enableOpenPR adds write permissions', () => {
  const yaml = generateWorkflow({ enableApply: true, enableOpenPR: true });
  expect(yaml).toContain('contents: write');
  expect(yaml).toContain('pull-requests: write');
});

test('generateWorkflow with enableApply + dryRun=false omits --dry-run', () => {
  const yaml = generateWorkflow({ enableApply: true, dryRun: false });
  // Dry-run should not be in the apply block
  expect(yaml).not.toContain('--dry-run');
});

test('generateWorkflow with enableApply + dryRun=true includes dry-run label', () => {
  const yaml = generateWorkflow({ enableApply: true, dryRun: true });
  expect(yaml).toContain('dry-run');
});

test('generateWorkflow dedicated branch prevents default-branch writes', () => {
  const yaml = generateWorkflow({ enableApply: true, dedicatedBranch: 'dep-intel/fixes' });
  expect(yaml).toContain('dep-intel/fixes');
});

test('generateWorkflow uploads artifacts by default', () => {
  const yaml = generateWorkflow();
  expect(yaml).toContain('upload-artifact');
});

test('generateWorkflow with uploadArtifacts=false omits artifact step', () => {
  const yaml = generateWorkflow({ uploadArtifacts: false });
  expect(yaml).not.toContain('upload-artifact');
});

test('generateWorkflow includes the specified Node.js version', () => {
  const yaml = generateWorkflow({ nodeVersion: '18' });
  expect(yaml).toContain("'18'");
});

test('generateWorkflow with schedule adds cron trigger', () => {
  const yaml = generateWorkflow({ schedule: '0 8 * * 1' });
  expect(yaml).toContain('cron');
  expect(yaml).toContain('0 8 * * 1');
});

test('generateWorkflow sets env credentials via env vars, not CLI args', () => {
  const yaml = generateWorkflow();
  // Credentials should be referenced as secrets, never passed as CLI args
  expect(yaml).not.toContain('--github-token');
  expect(yaml).not.toContain('--snyk-token');
});

test('generateWorkflow YAML starts with a comment describing the file', () => {
  const yaml = generateWorkflow();
  expect(yaml.startsWith('#')).toBe(true);
});

// ─── generateAzureDevOpsPipeline ─────────────────────────────────────────────

test('generateAzureDevOpsPipeline returns a non-empty string', () => {
  const yaml = generateAzureDevOpsPipeline();
  expect(typeof yaml).toBe('string');
  expect(yaml.length).toBeGreaterThan(0);
});

test('generateAzureDevOpsPipeline contains analyze step', () => {
  const yaml = generateAzureDevOpsPipeline();
  expect(yaml).toContain('analyze');
});

test('generateAzureDevOpsPipeline with enableApply adds apply step', () => {
  const yaml = generateAzureDevOpsPipeline({ enableApply: true });
  expect(yaml).toContain('apply');
});

test('generateAzureDevOpsPipeline includes artifact publish task', () => {
  const yaml = generateAzureDevOpsPipeline();
  expect(yaml).toContain('PublishBuildArtifacts');
});

test('generateAzureDevOpsPipeline with dryRun=false omits --dry-run', () => {
  const yaml = generateAzureDevOpsPipeline({ enableApply: true, dryRun: false });
  expect(yaml).not.toContain('--dry-run');
});

test('generateAzureDevOpsPipeline uses the specified node version', () => {
  const yaml = generateAzureDevOpsPipeline({ nodeVersion: '18.x' });
  expect(yaml).toContain('18.x');
});
