'use strict';

// libraryType → ecosystem mapping
const TYPE_MAP = {
  MAVEN_ARTIFACT:   'maven',
  PYTHON_PACKAGE:   'python',
  GO_MODULE:        'go',
  DOTNET_PACKAGE:   'dotnet',
  RUST_CRATE:       'rust',
};

// Any type not in TYPE_MAP is treated as npm.
function resolveEcosystem(libraryType) {
  return TYPE_MAP[libraryType] || 'npm';
}

/**
 * Detect the package ecosystem from parsed entries.
 *
 * Returns 'npm' | 'maven' | 'python' | 'go' | 'dotnet' | 'rust'.
 *
 * Throws when entries span multiple incompatible ecosystems — split the report
 * by ecosystem first, or use --ecosystem to force one.
 *
 * Explicit --ecosystem flag (overrideEcosystem) always takes precedence.
 */
function detectEcosystem(entries, overrideEcosystem) {
  if (overrideEcosystem) return overrideEcosystem;

  const ecosystems = new Set(
    entries.map(e => resolveEcosystem(e.libraryType)).filter(Boolean)
  );

  if (ecosystems.size === 0) return 'npm'; // empty plan → default

  if (ecosystems.size === 1) return [...ecosystems][0];

  // Mixed reports: throw unless all mixing is among npm-family types
  const nonNpm = [...ecosystems].filter(e => e !== 'npm');
  if (nonNpm.length === 0) return 'npm';

  throw new Error(
    `Mixed-ecosystem report detected (${[...ecosystems].join(' + ')} entries). ` +
    'Split the report by ecosystem before running mendfix, or use --ecosystem npm|maven|python|go|dotnet|rust to force one.'
  );
}

module.exports = { detectEcosystem };
