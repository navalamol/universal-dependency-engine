'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Executables this tool is permitted to run
const ALLOWED_EXECUTABLES = new Set([
  'npm', 'npx', 'mvn', 'mvnw',
  'git',
  'python', 'python3',
  'pip', 'pip3',
  'go',
  'cargo',
  'dotnet',
]);

// Shell metacharacters that must never appear in user-derived values used as args
const SHELL_META_RE = /[\0\r\n;|&$`'"\\<>(){}[\]!*?~^#]/;

/**
 * Resolve the real executable for Windows .cmd/.exe wrappers.
 * Searches PATH so 'npm' → full path to npm.cmd on Windows.
 * Returns the original name unchanged on non-Windows or when not found.
 */
function resolveExecutable(name) {
  if (process.platform !== 'win32') return name;
  if (path.isAbsolute(name)) return name;

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const exts     = ['.cmd', '.exe', ''];

  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore permission errors on individual dirs
      }
    }
  }
  return name;
}

/**
 * Validate a package name that came from an external source (vulnerability report, registry).
 * Rejects shell metacharacters and obviously invalid names.
 * Supports npm (@scope/name), cargo, Python PEP 508, Go module paths.
 *
 * @throws {Error} if the name is unsafe
 */
function validatePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Package name must be a non-empty string');
  }
  if (name.length > 512) {
    throw new Error(`Package name too long (${name.length} chars)`);
  }
  if (SHELL_META_RE.test(name)) {
    throw new Error(`Package name contains unsafe characters: ${JSON.stringify(name)}`);
  }
}

/**
 * Validate a version string from an external source.
 * Allows semver, pre-release labels, build metadata, Go v-prefix.
 *
 * @throws {Error} if the version is unsafe
 */
function validateVersion(ver) {
  if (typeof ver !== 'string' || ver.length === 0) {
    throw new Error('Version must be a non-empty string');
  }
  if (ver.length > 128) {
    throw new Error(`Version string too long (${ver.length} chars)`);
  }
  if (SHELL_META_RE.test(ver)) {
    throw new Error(`Version contains unsafe characters: ${JSON.stringify(ver)}`);
  }
  if (!/^[a-zA-Z0-9._+~\-]+$/.test(ver)) {
    throw new Error(`Version contains unexpected characters: ${JSON.stringify(ver)}`);
  }
}

/**
 * Validate a filesystem path to be used as a cwd or argument.
 * Rejects null bytes.
 *
 * @throws {Error} if the path is unsafe
 */
function validatePath(p) {
  if (typeof p !== 'string') throw new Error('Path must be a string');
  if (p.includes('\0')) throw new Error('Path contains null byte');
}

/**
 * Safe process spawner. Replaces execSync/spawnSync with shell-string templates.
 *
 * - Never uses shell interpretation (shell: false always)
 * - Validates executable against ALLOWED_EXECUTABLES by basename
 * - Resolves Windows .cmd wrappers
 * - Applies timeout and output-size limits
 * - Returns a structured result (never throws on non-zero exit)
 *
 * @param {string}   executable  bare name ('npm', 'cargo') or absolute path
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {string}   [opts.cwd]
 * @param {number}   [opts.timeout=120000]    ms
 * @param {number}   [opts.maxBuffer=10485760] bytes
 * @param {object}   [opts.env]              override environment (defaults to buildSafeEnv())
 * @returns {{ success: boolean, stdout: string, stderr: string, status: number|null, signal: string|null, duration: number, timedOut: boolean }}
 */
function safeSpawn(executable, args, opts = {}) {
  const baseName = path.basename(executable).replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (!ALLOWED_EXECUTABLES.has(baseName)) {
    throw new Error(`Executable not in allowlist: ${JSON.stringify(baseName)}`);
  }
  if (!Array.isArray(args)) throw new Error('safeSpawn: args must be an array');
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== 'string') {
      throw new Error(`safeSpawn: arg[${i}] must be a string, got ${typeof args[i]}`);
    }
    if (args[i].includes('\0')) {
      throw new Error(`safeSpawn: arg[${i}] contains null byte`);
    }
  }

  const timeout   = opts.timeout   || 120000;
  const maxBuffer = opts.maxBuffer || 10 * 1024 * 1024;
  const cwd       = opts.cwd;
  if (cwd) validatePath(cwd);

  const resolved = resolveExecutable(executable);
  const start    = Date.now();

  const result = spawnSync(resolved, args, {
    cwd,
    timeout,
    stdio:    'pipe',
    encoding: 'utf8',
    shell:    false,
    env:      opts.env || buildSafeEnv(),
    maxBuffer,
  });

  const duration = Date.now() - start;
  const stdout   = typeof result.stdout === 'string' ? result.stdout.slice(0, maxBuffer) : '';
  const stderr   = typeof result.stderr === 'string' ? result.stderr.slice(0, maxBuffer) : '';
  const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT') ||
                   result.signal === 'SIGTERM';

  return {
    success:  result.status === 0 && !result.error,
    stdout,
    stderr,
    status:   result.status,
    signal:   result.signal || null,
    duration,
    timedOut,
  };
}

/**
 * Minimal safe environment for child processes.
 * Forwards only variables that package-manager tools genuinely need.
 * Prevents accidental credential leakage via environment.
 */
function buildSafeEnv() {
  const env = {};
  const always = [
    'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
    'JAVA_HOME', 'JAVA_OPTS', 'MAVEN_HOME', 'M2_HOME',
    'GOPATH', 'GOROOT', 'GOPROXY', 'GONOSUMCHECK', 'GONOSUMDB', 'GOFLAGS',
    'CARGO_HOME', 'RUSTUP_HOME',
    'npm_config_cache', 'npm_config_prefix', 'npm_config_registry',
    'PYTHON_PATH', 'PYTHONPATH',
  ];
  for (const key of always) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.platform === 'win32') {
    for (const key of ['COMSPEC', 'PATHEXT', 'WINDIR', 'SYSTEMROOT', 'SystemDrive']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return env;
}

module.exports = {
  safeSpawn,
  resolveExecutable,
  validatePackageName,
  validateVersion,
  validatePath,
  buildSafeEnv,
  ALLOWED_EXECUTABLES,
};
