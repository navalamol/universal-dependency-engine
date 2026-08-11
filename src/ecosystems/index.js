'use strict';

// Detect the package ecosystem from parsed entries.
// Returns 'maven' if all entries are Maven artifacts, 'npm' if all are npm,
// or throws if entries span both ecosystems (mixed reports must be split before processing).
// Explicit --ecosystem flag takes precedence.
function detectEcosystem(entries, overrideEcosystem) {
  if (overrideEcosystem) return overrideEcosystem;
  const types = new Set(entries.map(e => e.libraryType).filter(Boolean));
  const hasMaven = types.has('MAVEN_ARTIFACT');
  const hasNpm   = [...types].some(t => t !== 'MAVEN_ARTIFACT');
  if (hasMaven && hasNpm) {
    throw new Error(
      'Mixed-ecosystem report detected (npm + Maven entries). ' +
      'Split the report by ecosystem before running mendfix, or use --ecosystem maven|npm to force one.'
    );
  }
  return hasMaven ? 'maven' : 'npm';
}

module.exports = { detectEcosystem };
