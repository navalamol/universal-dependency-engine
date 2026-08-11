'use strict';

// Scenarios 15/16: Auto-generate commits by confidence tier.
// Phase A (high confidence) → one commit, automated.
// Phase B/C (reviewed) → separate commit, requires human staging first.
// False positives → docs-only commit.

const { spawnSync } = require('child_process');
const path = require('path');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { success: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

// Scenario 15: Auto-commit Phase A high-confidence fixes.
// Stages package.json + package-lock.json (or pom.xml), then commits.
function commitPhaseA(projectDir, phaseAItems, ecosystem) {
  const files = ecosystem === 'maven'
    ? ['pom.xml']
    : ['package.json', 'package-lock.json', '.mend-manifest.json'];

  const staged = [];
  for (const f of files) {
    const full = path.join(projectDir, f);
    const result = git(projectDir, ['add', full]);
    if (result.success) staged.push(f);
  }

  if (staged.length === 0) return { success: false, message: 'Nothing staged' };

  const pkgList = phaseAItems.map(i => `${i.libraryName} ${i.currentVersion}→${i.recommendedVersion}`).join(', ');
  const message = `fix(deps): apply Phase A security fixes\n\nAuto-applied by mend-autofixer (95-100% confidence)\nPackages: ${pkgList}`;

  const result = git(projectDir, ['commit', '-m', message]);
  return { success: result.success, message: result.success ? message : result.stderr };
}

// Scenario 16: Commit Phase B/C after human review.
// Assumes human has already staged the relevant files.
function commitPhaseBC(projectDir, phaseBItems, phaseCItems) {
  const items = [...phaseBItems, ...phaseCItems];
  const pkgList = items.map(i => `${i.libraryName} (Phase ${i.phase})`).join(', ');
  const message = `fix(deps): apply reviewed security fixes (Phase B/C)\n\nApplied after manual review\nPackages: ${pkgList}`;

  const result = git(projectDir, ['commit', '-m', message]);
  return { success: result.success, message: result.success ? message : result.stderr };
}

// Commit false positive justifications (docs only, no code changes).
function commitFalsePositives(projectDir, falsePositiveItems) {
  const pkgList = falsePositiveItems.map(i => i.libraryName).join(', ');
  const message = `docs(security): add false positive justifications\n\nPackages accepted as false positives after chain analysis: ${pkgList}`;

  const result = git(projectDir, ['commit', '-m', message]);
  return { success: result.success, message: result.success ? message : result.stderr };
}

module.exports = { commitPhaseA, commitPhaseBC, commitFalsePositives };
