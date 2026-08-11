'use strict';

const { spawnSync } = require('child_process');

/**
 * Build a DepTree (Map<name, Entry[]>) from Maven's dependency:tree text output.
 *
 * Each Entry:
 *   { resolvedVersion: string, dev: false, parents: [{ name: string, range: string }] }
 *
 * Maven has no dev concept — dev is always false.
 * "range" is set to the resolved version string (exact pin), since Maven's POM
 * specifies exact or range declarations; the tree output only shows resolved versions.
 *
 * @param {string} projectDir  - directory containing pom.xml
 * @returns {Map|null}  DepTree, or null if mvn is unavailable or the tree cannot be parsed
 */
function buildMavenDepTree(projectDir) {
  const result = spawnSync(
    'mvn',
    ['dependency:tree', '-DoutputType=text', '-B'],
    { cwd: projectDir, encoding: 'utf8', shell: true }
  );

  if (result.status !== 0) {
    console.warn(`  Warning: mvn dependency:tree failed — running Maven analysis without dep-tree enrichment`);
    return null;
  }

  return parseMavenDepTreeText(result.stdout || '');
}

/**
 * Parse the text output of `mvn dependency:tree -DoutputType=text`.
 *
 * Line format:
 *   [INFO] com.example:myproject:jar:1.0 (root)
 *   [INFO] +- org.slf4j:slf4j-api:jar:2.0.16:compile
 *   [INFO] |  \- ch.qos.logback:logback-classic:jar:1.5.18:compile
 *
 * Each non-root artifact: groupId:artifactId:type:version:scope
 */
function parseMavenDepTreeText(text) {
  const depMap = new Map();
  const lines  = text.split('\n');

  // Stack: each element is { name: string (artifactId), version: string }
  // Root is at depth 0; depth determined by indent characters (+- \- |  )
  const depthStack = [];

  for (const rawLine of lines) {
    const infoIdx = rawLine.indexOf('[INFO] ');
    if (infoIdx === -1) continue;
    const line = rawLine.slice(infoIdx + 7);

    // Detect root artifact (no tree prefix characters)
    const rootMatch = line.match(/^([\w.\-]+):([\w.\-]+):\w+:([\d.\-\w]+)/);
    if (rootMatch && !line.match(/^[+\\| ]/)) {
      depthStack.length = 0;
      depthStack.push({ name: rootMatch[2], version: rootMatch[3], depth: 0 });
      continue;
    }

    // Match tree lines: "+- " "\- " "|  " prefix then groupId:artifactId:type:version:scope
    const treeMatch = line.match(/^([+\\| ]*[+\\]-\s)([\w.\-]+):([\w.\-]+):\w+:([\d.\-\w]+):(\w+)/);
    if (!treeMatch) continue;

    const prefix    = treeMatch[1];
    const groupId   = treeMatch[2];
    const artifactId = treeMatch[3];
    const version   = treeMatch[4];
    const scope     = treeMatch[5];

    // Depth = number of '|' or ' ' pairs before the connector
    const depth = Math.floor(prefix.replace(/[+\\]-\s*$/, '').length / 3) + 1;

    // Trim stack to current depth
    while (depthStack.length > depth) depthStack.pop();

    const parentEntry = depthStack[depthStack.length - 1] || null;
    // Maven tree output shows resolved versions, not declared ranges.
    // Use '*' so findRangeViolation never produces false Phase B downgrades for Maven entries.
    const parents = parentEntry ? [{ name: parentEntry.name, range: '*' }] : [];

    const name = artifactId;
    if (!depMap.has(name)) depMap.set(name, []);
    depMap.get(name).push({
      resolvedVersion: version,
      dev: scope === 'test',
      parents,
      groupId,
    });

    depthStack.push({ name, version, depth });
  }

  return depMap;
}

module.exports = { buildMavenDepTree, parseMavenDepTreeText };
