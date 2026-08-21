'use strict';

// M2.1 — Build/test verification.
// Runs a user-supplied list of commands against a project directory
// after remediation and returns a structured result for the evidence model.
//
// Command format: string or { cmd: string, args?: string[], required?: boolean }
// String form: split on first space → [exe, ...rest], exe must be in ALLOWED_EXECUTABLES.
// A command with required:true (the default) blocks Phase A on failure.
// A command with required:false is advisory — failure is recorded but does not block.

const { safeSpawn, resolveExecutable, validatePath, ALLOWED_EXECUTABLES } = require('./safe-exec');

// Split a command string into [executable, ...args].
// Rejects anything whose first token is not in the allowlist.
function _parseCommandString(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) throw new Error(`Empty command string: ${JSON.stringify(str)}`);
  return { exe: parts[0], args: parts.slice(1) };
}

function _normalizeCommand(raw) {
  if (typeof raw === 'string') {
    const { exe, args } = _parseCommandString(raw);
    return { exe, args, required: true };
  }
  if (typeof raw === 'object' && raw !== null && typeof raw.cmd === 'string') {
    const { exe, args } = _parseCommandString(raw.cmd);
    return { exe, args: raw.args ? [...raw.args] : args, required: raw.required !== false };
  }
  throw new Error(`Invalid command specification: ${JSON.stringify(raw)}`);
}

/**
 * Run a list of verification commands in a project directory.
 * Stops on the first required failure (fail-fast).
 *
 * @param {Array<string|object>} commands  - command strings or command objects
 * @param {string}               projectDir
 * @param {object}               [opts]
 * @param {number}               [opts.timeout=120000]  ms per command
 * @param {boolean}              [opts.failFast=true]   stop on first required failure
 * @returns {{ passed: boolean, commands: string[], commandResults: object[],
 *             durationMs: number, failureReason: string|null, ranAt: string }}
 */
function runVerification(commands, projectDir, opts = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('runVerification: commands must be a non-empty array');
  }
  validatePath(projectDir);

  const timeout  = opts.timeout  || 120000;
  const failFast = opts.failFast !== false;
  const ranAt    = new Date().toISOString();
  const start    = Date.now();

  const commandResults = [];
  let passed        = true;
  let failureReason = null;

  for (const raw of commands) {
    let normalized;
    try {
      normalized = _normalizeCommand(raw);
    } catch (e) {
      const result = { command: String(raw), success: false, required: true, error: e.message };
      commandResults.push(result);
      if (failFast) { passed = false; failureReason = e.message; break; }
      passed = false;
      if (!failureReason) failureReason = e.message;
      continue;
    }

    const { exe, args, required } = normalized;
    const cmdLabel = [exe, ...args].join(' ');

    // Validate exe is allowlisted before calling safeSpawn
    const baseName = exe.split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, '').toLowerCase();
    if (!ALLOWED_EXECUTABLES.has(baseName)) {
      const err = `Executable not in allowlist: ${JSON.stringify(baseName)}`;
      commandResults.push({ command: cmdLabel, success: false, required, error: err });
      if (required) {
        passed = false;
        if (!failureReason) failureReason = err;
        if (failFast) break;
      }
      continue;
    }

    let spawnResult;
    try {
      spawnResult = safeSpawn(exe, args, { cwd: projectDir, timeout });
    } catch (e) {
      commandResults.push({ command: cmdLabel, success: false, required, error: e.message });
      if (required) {
        passed = false;
        if (!failureReason) failureReason = e.message;
        if (failFast) break;
      }
      continue;
    }

    const cmdResult = {
      command:    cmdLabel,
      success:    spawnResult.success,
      required,
      exitCode:   spawnResult.status,
      durationMs: spawnResult.duration,
      timedOut:   spawnResult.timedOut,
      stdout:     spawnResult.stdout.slice(0, 2048),
      stderr:     spawnResult.stderr.slice(0, 2048),
    };
    commandResults.push(cmdResult);

    if (!spawnResult.success && required) {
      passed = false;
      if (!failureReason) {
        if (spawnResult.timedOut) {
          failureReason = `Command timed out: ${cmdLabel}`;
        } else {
          failureReason = `Command failed (exit ${spawnResult.status}): ${cmdLabel}`;
        }
      }
      if (failFast) break;
    }
  }

  return {
    passed,
    commands:       commandResults.map(r => r.command),
    commandResults,
    durationMs:     Date.now() - start,
    failureReason,
    ranAt,
  };
}

module.exports = { runVerification };
