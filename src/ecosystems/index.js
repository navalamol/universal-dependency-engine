'use strict';

// Detect the package ecosystem from parsed entries.
// Returns 'maven' if any entry is a Maven artifact, otherwise 'npm'.
// Explicit --ecosystem flag takes precedence.
function detectEcosystem(entries, overrideEcosystem) {
  if (overrideEcosystem) return overrideEcosystem;
  const types = new Set(entries.map(e => e.libraryType).filter(Boolean));
  return types.has('MAVEN_ARTIFACT') ? 'maven' : 'npm';
}

module.exports = { detectEcosystem };
