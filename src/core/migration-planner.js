'use strict';

// D2.2 + D2.3 — Replacement and major migration planner.
//
// D2.2: Alternative-package intelligence
//   Provides a curated catalogue of common replacements + a scoring function.
//   Score = weighted sum of: capability coverage, security history, migration effort,
//   license, and maintenance health. All scoring is transparent and deterministic.
//
// D2.3: Migration strategy comparison
//   For a Phase C MAJOR_BUMP or REQUIRES_MIGRATION item, selects and compares
//   the viable migration strategies (direct upgrade, major-by-major, adapter,
//   strangler fig, dual-run, internal fork, feature removal).
//   Generates major-migration-plan.md.

const fs   = require('fs');
const path = require('path');

// ─── D2.2 Curated alternatives catalogue ─────────────────────────────────────

const ALTERNATIVES_CATALOGUE = {
  // Legacy request → modern alternatives
  'request': [
    { name: 'node-fetch',  reason: 'Lightweight fetch polyfill; mirrors browser Fetch API', capabilityScore: 0.8, securityScore: 0.9, migrationEffort: 'medium', license: 'MIT' },
    { name: 'axios',       reason: 'Full-featured HTTP client, interceptors, streaming', capabilityScore: 0.95, securityScore: 0.85, migrationEffort: 'low', license: 'MIT' },
    { name: 'got',         reason: 'Actively maintained; streams, retry, RFC-compliant', capabilityScore: 0.9, securityScore: 0.9, migrationEffort: 'medium', license: 'MIT' },
    { name: 'undici',      reason: 'Node.js built-in HTTP/1.1 client (Node 18+)', capabilityScore: 0.85, securityScore: 0.95, migrationEffort: 'medium', license: 'MIT' },
  ],
  // Moment.js → modern alternatives
  'moment': [
    { name: 'dayjs',       reason: 'Moment-compatible API; tree-shakeable; 2KB', capabilityScore: 0.9, securityScore: 0.9, migrationEffort: 'low', license: 'MIT' },
    { name: 'date-fns',    reason: 'Functional, tree-shakeable, TypeScript support', capabilityScore: 0.95, securityScore: 0.9, migrationEffort: 'medium', license: 'MIT' },
    { name: 'luxon',       reason: 'Full-featured Intl API-based; immutable', capabilityScore: 0.9, securityScore: 0.9, migrationEffort: 'high', license: 'MIT' },
  ],
  // uuid v3 → v4+
  'uuid': [
    { name: 'uuid',        reason: 'Same package — upgrade to v4+ (MAJOR_BUMP)', capabilityScore: 1.0, securityScore: 0.95, migrationEffort: 'low', license: 'MIT', samePackage: true },
    { name: 'crypto.randomUUID', reason: 'Native Node.js (v15.6+); no dependency', capabilityScore: 0.7, securityScore: 1.0, migrationEffort: 'low', license: 'built-in', native: true },
  ],
  // nanoid v3 → v4+
  'nanoid': [
    { name: 'nanoid',      reason: 'Same package — upgrade to v4+ (ESM, MAJOR_BUMP)', capabilityScore: 1.0, securityScore: 0.95, migrationEffort: 'low', license: 'MIT', samePackage: true },
    { name: 'crypto.randomUUID', reason: 'Native UUID if UUIDs are acceptable', capabilityScore: 0.6, securityScore: 1.0, migrationEffort: 'low', license: 'built-in', native: true },
  ],
  // tough-cookie → alternatives
  'tough-cookie': [
    { name: 'cookie',      reason: 'RFC 6265 cookie parser; simpler API', capabilityScore: 0.7, securityScore: 0.9, migrationEffort: 'medium', license: 'MIT' },
  ],
  // node-forge → alternatives
  'node-forge': [
    { name: 'node:crypto', reason: 'Native crypto; covers most forge use cases', capabilityScore: 0.8, securityScore: 1.0, migrationEffort: 'high', license: 'built-in', native: true },
  ],
};

// ─── Migration strategies (D2.3) ─────────────────────────────────────────────

const MIGRATION_STRATEGIES = Object.freeze({
  DIRECT_UPGRADE:    'DIRECT_UPGRADE',       // bump version in place
  MAJOR_BY_MAJOR:    'MAJOR_BY_MAJOR',       // upgrade one major at a time
  ADAPTER:           'ADAPTER',              // thin shim to new API
  STRANGLER_FIG:     'STRANGLER_FIG',        // parallel paths, migrate gradually
  DUAL_RUN:          'DUAL_RUN',             // run old + new in parallel, compare
  INTERNAL_FORK:     'INTERNAL_FORK',        // fork + apply patch internally
  FEATURE_REMOVAL:   'FEATURE_REMOVAL',      // remove feature that depends on package
  REPLACEMENT:       'REPLACEMENT',          // swap to alternative package
});

// ─── D2.2: findAlternatives ───────────────────────────────────────────────────

/**
 * Find alternatives for a package from the curated catalogue.
 * Scores each alternative on capability, security, effort, and license.
 * Returns candidates sorted by composite score descending.
 *
 * @param {string}  packageName
 * @param {object}  [opts]
 * @param {string[]} [opts.orgApproved]   - org-approved package names (bonus score)
 * @returns {object[]} scored alternatives
 */
function findAlternatives(packageName, opts = {}) {
  const { orgApproved = [] } = opts;
  const raw = ALTERNATIVES_CATALOGUE[packageName] || [];

  return raw.map(alt => {
    // Effort score: low=1.0, medium=0.6, high=0.2
    const effortScore = { low: 1.0, medium: 0.6, high: 0.2 }[alt.migrationEffort] || 0.5;

    // License score: MIT/Apache=1.0, built-in=1.0, other=0.7
    const licenseScore = (alt.license === 'MIT' || alt.license === 'Apache-2.0' || alt.license === 'built-in') ? 1.0 : 0.7;

    // Org-approved bonus
    const orgBonus = orgApproved.includes(alt.name) ? 0.1 : 0;

    // Composite: weighted average
    const composite = (
      alt.capabilityScore * 0.35 +
      alt.securityScore   * 0.30 +
      effortScore         * 0.25 +
      licenseScore        * 0.10 +
      orgBonus
    );

    return {
      ...alt,
      effortScore,
      licenseScore,
      compositeScore: Math.min(composite, 1.0),
    };
  }).sort((a, b) => b.compositeScore - a.compositeScore);
}

// ─── D2.3: selectStrategy ─────────────────────────────────────────────────────

/**
 * Select and rank applicable migration strategies for a Phase C item.
 * Returns strategies in order from least to most invasive.
 *
 * @param {object}   item         - PhasedItem (phase C, MAJOR_BUMP or NO_FIX)
 * @param {object[]} alternatives - output of findAlternatives
 * @param {object}   [fingerprint]- output of buildFingerprint
 * @returns {Array<{ strategy, rationale, effort, risk, recommended: boolean }>}
 */
function selectStrategy(item, alternatives, fingerprint) {
  const strategies = [];
  const effort = fingerprint ? fingerprint.effortEstimate : 'unknown';

  // DIRECT_UPGRADE: only if there's a safe fix within the same major
  if (item.upgradeType === 'SAFE' && item.recommendedVersion) {
    strategies.push({
      strategy:    MIGRATION_STRATEGIES.DIRECT_UPGRADE,
      rationale:   `Same-major upgrade: ${item.currentVersion} → ${item.recommendedVersion}`,
      effort:      'low',
      risk:        'low',
      recommended: true,
    });
  }

  // MAJOR_BY_MAJOR: for large version gaps
  if (item.upgradeType === 'MAJOR_BUMP' && item.recommendedVersion) {
    const curMajor = parseInt(item.currentVersion, 10);
    const fixMajor = parseInt(item.recommendedVersion, 10);
    if (!isNaN(curMajor) && !isNaN(fixMajor) && fixMajor - curMajor > 1) {
      strategies.push({
        strategy:    MIGRATION_STRATEGIES.MAJOR_BY_MAJOR,
        rationale:   `Upgrade ${item.libraryName} one major at a time to reduce blast radius`,
        effort:      effort === 'high' ? 'high' : 'medium',
        risk:        'medium',
        recommended: effort !== 'high',
      });
    }

    strategies.push({
      strategy:    MIGRATION_STRATEGIES.DIRECT_UPGRADE,
      rationale:   `Direct major bump: ${item.currentVersion} → ${item.recommendedVersion}. Breaking changes likely.`,
      effort:      effort,
      risk:        effort === 'high' ? 'high' : 'medium',
      recommended: effort === 'trivial' || effort === 'low',
    });
  }

  // REPLACEMENT: if alternatives exist
  if (alternatives && alternatives.length > 0) {
    const best = alternatives[0];
    if (!best.samePackage) {
      strategies.push({
        strategy:    MIGRATION_STRATEGIES.REPLACEMENT,
        rationale:   `Replace ${item.libraryName} with ${best.name} (composite score: ${best.compositeScore.toFixed(2)}). ${best.reason}`,
        effort:      best.migrationEffort,
        risk:        best.migrationEffort === 'low' ? 'low' : 'medium',
        recommended: best.compositeScore >= 0.8 && best.migrationEffort !== 'high',
      });
    }
  }

  // ADAPTER: for high-effort migrations
  if (effort === 'high' || effort === 'medium') {
    strategies.push({
      strategy:    MIGRATION_STRATEGIES.ADAPTER,
      rationale:   `Introduce a thin adapter shim around ${item.libraryName}. Migrate callers behind the adapter.`,
      effort:      'medium',
      risk:        'low',
      recommended: effort === 'high',
    });
  }

  // STRANGLER_FIG: for very widespread usage
  if (fingerprint && fingerprint.filesWithUsage > 10) {
    strategies.push({
      strategy:    MIGRATION_STRATEGIES.STRANGLER_FIG,
      rationale:   `${fingerprint.filesWithUsage} files use ${item.libraryName}. Migrate gradually using strangler fig pattern.`,
      effort:      'high',
      risk:        'low',
      recommended: false,
    });
  }

  // INTERNAL_FORK: when no fix and no alternative
  if (item.upgradeType === 'NO_FIX' && (!alternatives || alternatives.length === 0)) {
    strategies.push({
      strategy:    MIGRATION_STRATEGIES.INTERNAL_FORK,
      rationale:   `No fix available for ${item.libraryName}. Fork internally and apply CVE patch.`,
      effort:      'high',
      risk:        'high',
      recommended: false,
    });
  }

  // Always include FEATURE_REMOVAL as last resort
  strategies.push({
    strategy:    MIGRATION_STRATEGIES.FEATURE_REMOVAL,
    rationale:   `Remove the feature(s) that depend on ${item.libraryName} if they are non-critical.`,
    effort:      'varies',
    risk:        'high',
    recommended: false,
  });

  return strategies;
}

// ─── generateMigrationPlan ────────────────────────────────────────────────────

/**
 * Generate a major-migration-plan.md for all Phase C items.
 *
 * @param {object[]} phasedPlan    - PhasedItem[]
 * @param {object}   [opts]
 * @param {string}   [opts.project]
 * @param {string}   [opts.reportDate]
 * @param {object}   [opts.orgApproved]  - { packageName: string[] }
 * @param {Map}      [opts.fingerprints] - Map<libraryName, fingerprint>
 * @returns {string} markdown content
 */
function generateMigrationPlan(phasedPlan, opts = {}) {
  const { project, reportDate, orgApproved = {}, fingerprints = new Map() } = opts;
  const phaseCItems = (phasedPlan || []).filter(i => i.phase === 'C');

  const lines = [];
  lines.push(`# Major Migration Plan${project ? ` — ${project}` : ''}`);
  lines.push(`**Generated:** ${reportDate || new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`> This plan covers ${phaseCItems.length} Phase C item(s) requiring migration.`);
  lines.push('> Phase C items are NEVER auto-applied. Each requires human review and approval.');
  lines.push('');

  if (phaseCItems.length === 0) {
    lines.push('No Phase C items found — no migration plan needed.');
    return lines.join('\n');
  }

  for (const item of phaseCItems) {
    const alts        = findAlternatives(item.libraryName, { orgApproved: orgApproved[item.libraryName] || [] });
    const fingerprint = fingerprints.get(item.libraryName) || null;
    const strategies  = selectStrategy(item, alts, fingerprint);

    lines.push(`---`);
    lines.push('');
    lines.push(`## \`${item.libraryName}\` ${item.currentVersion} → ${item.recommendedVersion || 'no fix'}`);
    lines.push('');
    lines.push(`**Upgrade type:** ${item.upgradeType}  |  **Phase:** C`);
    lines.push(`**CVEs:** ${(item.cves || []).map(c => c.id).join(', ') || 'none'}`);
    lines.push(`**Justification:** ${item.justification || '—'}`);
    lines.push('');

    if (fingerprint) {
      lines.push('### Usage Fingerprint');
      lines.push('');
      lines.push(`- **Files with usage:** ${fingerprint.filesWithUsage}`);
      lines.push(`- **Usages found:** ${fingerprint.usageCount}`);
      lines.push(`- **Symbols imported:** ${fingerprint.symbols.join(', ') || 'none detected'}`);
      lines.push(`- **Effort estimate:** ${fingerprint.effortEstimate} — ${fingerprint.effortBasis}`);
      lines.push('');
    }

    if (alts.length > 0) {
      lines.push('### Alternatives');
      lines.push('');
      lines.push('| Package | Capability | Security | Migration | Composite |');
      lines.push('|---------|-----------|----------|-----------|-----------|');
      for (const alt of alts) {
        const score = (alt.compositeScore * 100).toFixed(0);
        lines.push(`| \`${alt.name}\` | ${_pct(alt.capabilityScore)} | ${_pct(alt.securityScore)} | ${alt.migrationEffort} | ${score}% |`);
      }
      lines.push('');
      lines.push(`> Top recommendation: **${alts[0].name}** — ${alts[0].reason}`);
      lines.push('');
    }

    lines.push('### Migration Strategies');
    lines.push('');
    const recommended = strategies.filter(s => s.recommended);
    const others      = strategies.filter(s => !s.recommended);

    if (recommended.length) {
      lines.push('**Recommended:**');
      for (const s of recommended) {
        lines.push(`- **${s.strategy}** (effort: ${s.effort}, risk: ${s.risk}): ${s.rationale}`);
      }
      lines.push('');
    }
    if (others.length) {
      lines.push('**Alternative options:**');
      for (const s of others) {
        lines.push(`- ${s.strategy} (effort: ${s.effort}, risk: ${s.risk}): ${s.rationale}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── writeMigrationPlan ───────────────────────────────────────────────────────

/**
 * Write a migration plan to disk.
 *
 * @param {object[]} phasedPlan
 * @param {string}   outDir
 * @param {object}   [opts]
 * @returns {string} file path
 */
function writeMigrationPlan(phasedPlan, outDir, opts = {}) {
  const content  = generateMigrationPlan(phasedPlan, opts);
  const filename = opts.filename || 'major-migration-plan.md';
  const outPath  = path.join(outDir, filename);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

function _pct(score) {
  return `${Math.round(score * 100)}%`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  MIGRATION_STRATEGIES,
  ALTERNATIVES_CATALOGUE,
  findAlternatives,
  selectStrategy,
  generateMigrationPlan,
  writeMigrationPlan,
};
