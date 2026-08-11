'use strict';

// Scenario 14: Every recommendation carries Confidence + Reason + Evidence + Alternative.
// Called after applyPhases() to enrich each PhasedItem with structured justification data.

function enrichWithConfidence(phasedPlan, depTree) {
  return phasedPlan.map(item => ({
    ...item,
    evidence:    buildEvidence(item, depTree),
    alternative: buildAlternative(item),
  }));
}

function buildEvidence(item, depTree) {
  const facts = [];

  if (item.upgradeType === 'SAFE') {
    facts.push(`Same-major upgrade: ${item.currentVersion} → ${item.recommendedVersion}`);
  } else if (item.upgradeType === 'MAJOR_BUMP') {
    facts.push(`Major version change required: ${item.currentVersion} → ${item.recommendedVersion}`);
  } else if (item.upgradeType === 'NO_FIX') {
    facts.push('No fix version available in the vulnerability report');
  }

  if (item.rangeViolation) {
    facts.push(`Consumer \`${item.rangeViolation.consumer}\` pins range \`${item.rangeViolation.range}\` which does not satisfy ${item.recommendedVersion}`);
  }

  if (item.probableFalsePositive) {
    facts.push('All dependency chains are dev/build-only (no runtime exposure)');
  }

  if (depTree) {
    const entries = depTree.get(item.libraryName) || [];
    if (entries.length > 0) {
      facts.push(`${entries.length} instance(s) found in lock file`);
      const devOnly = entries.every(e => e.dev);
      if (devOnly) facts.push('All lock-file entries marked dev:true');
    }
  }

  if (item.registryExists === false) {
    facts.push(`Version ${item.recommendedVersion} not found on registry`);
  } else if (item.registryAdjusted) {
    facts.push(`Version adjusted from ${item.registryRequested} to ${item.recommendedVersion} (nearest published)`);
  }

  return facts.join('; ') || 'No additional evidence';
}

function buildAlternative(item) {
  if (item.upgradeType === 'MAJOR_BUMP') {
    if (item.rootParents && item.rootParents.length > 0) {
      const parents = item.rootParents.map(p => p.name).join(', ');
      return `Upgrade parent package(s) ${parents} to a version that ships ${item.libraryName} >= ${item.recommendedVersion}`;
    }
    return `Upgrade ${item.libraryName} directly to ${item.recommendedVersion} after reviewing breaking changes`;
  }

  if (item.upgradeType === 'NO_FIX') {
    return item.probableFalsePositive
      ? 'Accept as false positive — confirm all consumers are dev/build-only via `npm ls --prod` or `mvn dependency:tree`'
      : `Monitor upstream for a fix; consider replacing ${item.libraryName} if runtime exposure is confirmed`;
  }

  if (item.phase === 'B' && item.rangeViolation) {
    return `Upgrade parent \`${item.rangeViolation.consumer}\` to a version whose declared range for ${item.libraryName} satisfies ${item.recommendedVersion}`;
  }

  if (item.phase === 'B') {
    return 'Check if a parent package upgrade eliminates the need for this override';
  }

  return '';
}

module.exports = { enrichWithConfidence };
