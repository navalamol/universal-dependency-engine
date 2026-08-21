'use strict';

jest.mock('../../src/core/safe-exec', () => ({
  safeSpawn:          jest.fn(),
  resolveExecutable:  (name) => name,
  validatePath:       (p) => { if (p.includes('\0')) throw new Error('null byte'); },
  ALLOWED_EXECUTABLES: new Set(['npm', 'npx', 'mvn', 'git', 'python', 'python3', 'pip', 'pip3', 'go', 'cargo', 'dotnet']),
}));

const { safeSpawn } = require('../../src/core/safe-exec');
const { runVerification } = require('../../src/core/verifier');

const OK_RESULT    = { success: true,  status: 0,  duration: 100, timedOut: false, stdout: 'ok',    stderr: '' };
const FAIL_RESULT  = { success: false, status: 1,  duration: 200, timedOut: false, stdout: '',      stderr: 'fail' };
const TIMEOUT_RESULT = { success: false, status: null, duration: 30000, timedOut: true, stdout: '', stderr: '' };

beforeEach(() => { safeSpawn.mockReset(); });

// ─── Argument validation ──────────────────────────────────────────────────────

test('throws when commands is empty array', () => {
  expect(() => runVerification([], '/project')).toThrow('non-empty array');
});

test('throws when commands is not an array', () => {
  expect(() => runVerification('npm test', '/project')).toThrow();
});

test('throws when projectDir is not a string', () => {
  expect(() => runVerification(['npm test'], null)).toThrow();
});

// ─── Single passing command ───────────────────────────────────────────────────

test('single passing command → passed:true', () => {
  safeSpawn.mockReturnValue(OK_RESULT);
  const result = runVerification(['npm test'], '/project');
  expect(result.passed).toBe(true);
  expect(result.failureReason).toBeNull();
  expect(result.commands).toEqual(['npm test']);
  expect(result.commandResults).toHaveLength(1);
  expect(result.commandResults[0].success).toBe(true);
});

test('result includes durationMs and ranAt', () => {
  safeSpawn.mockReturnValue(OK_RESULT);
  const result = runVerification(['npm test'], '/project');
  expect(typeof result.durationMs).toBe('number');
  expect(typeof result.ranAt).toBe('string');
});

// ─── Single failing required command ─────────────────────────────────────────

test('single failing required command → passed:false + failureReason', () => {
  safeSpawn.mockReturnValue(FAIL_RESULT);
  const result = runVerification(['npm test'], '/project');
  expect(result.passed).toBe(false);
  expect(result.failureReason).toMatch(/npm test/);
});

// ─── Optional (required:false) command failure ───────────────────────────────

test('failing optional command does not set passed:false', () => {
  safeSpawn.mockReturnValue(FAIL_RESULT);
  const result = runVerification([{ cmd: 'npm test', required: false }], '/project');
  expect(result.passed).toBe(true);
  expect(result.failureReason).toBeNull();
  expect(result.commandResults[0].required).toBe(false);
});

// ─── failFast behaviour ───────────────────────────────────────────────────────

test('failFast:true stops after first required failure', () => {
  safeSpawn.mockReturnValueOnce(FAIL_RESULT);
  const result = runVerification(['npm build', 'npm test'], '/project', { failFast: true });
  expect(safeSpawn).toHaveBeenCalledTimes(1);
  expect(result.passed).toBe(false);
});

test('failFast:false runs all commands even after required failure', () => {
  safeSpawn.mockReturnValue(FAIL_RESULT);
  const result = runVerification(['npm build', 'npm test'], '/project', { failFast: false });
  expect(safeSpawn).toHaveBeenCalledTimes(2);
  expect(result.passed).toBe(false);
  expect(result.commandResults).toHaveLength(2);
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

test('timed-out command sets failureReason with "timed out"', () => {
  safeSpawn.mockReturnValue(TIMEOUT_RESULT);
  const result = runVerification(['npm test'], '/project');
  expect(result.passed).toBe(false);
  expect(result.failureReason).toMatch(/timed out/i);
  expect(result.commandResults[0].timedOut).toBe(true);
});

// ─── Command string parsing ───────────────────────────────────────────────────

test('command string with args splits correctly', () => {
  safeSpawn.mockReturnValue(OK_RESULT);
  runVerification(['npm run build'], '/project');
  expect(safeSpawn).toHaveBeenCalledWith('npm', ['run', 'build'], expect.any(Object));
});

test('object command with separate args array', () => {
  safeSpawn.mockReturnValue(OK_RESULT);
  runVerification([{ cmd: 'npm', args: ['run', 'test:ci'] }], '/project');
  expect(safeSpawn).toHaveBeenCalledWith('npm', ['run', 'test:ci'], expect.any(Object));
});

test('invalid command specification → command fails gracefully (not a throw)', () => {
  const result = runVerification([42], '/project');
  expect(result.passed).toBe(false);
  expect(result.commandResults[0].error).toBeDefined();
});

// ─── Non-allowlisted executable ──────────────────────────────────────────────

test('non-allowlisted executable → recorded failure without calling safeSpawn', () => {
  const result = runVerification(['bash -c echo'], '/project');
  expect(safeSpawn).not.toHaveBeenCalled();
  expect(result.passed).toBe(false);
  expect(result.failureReason).toMatch(/allowlist/i);
});

// ─── Multiple commands, mixed results ────────────────────────────────────────

test('two commands: first passes, second fails → passed:false', () => {
  safeSpawn
    .mockReturnValueOnce(OK_RESULT)
    .mockReturnValueOnce(FAIL_RESULT);
  const result = runVerification(['npm build', 'npm test'], '/project');
  expect(result.passed).toBe(false);
  // Both commands run: first passes, second fails, failFast stops here
  expect(safeSpawn).toHaveBeenCalledTimes(2);
});

test('two commands both pass → passed:true', () => {
  safeSpawn.mockReturnValue(OK_RESULT);
  const result = runVerification(['npm build', 'npm test'], '/project');
  expect(result.passed).toBe(true);
  expect(result.commandResults).toHaveLength(2);
});

// ─── safeSpawn throws (e.g. env build error) ─────────────────────────────────

test('safeSpawn throwing is caught and recorded as failure', () => {
  safeSpawn.mockImplementation(() => { throw new Error('spawn error'); });
  const result = runVerification(['npm test'], '/project');
  expect(result.passed).toBe(false);
  expect(result.commandResults[0].error).toMatch(/spawn error/);
});

// ─── stdout/stderr truncation ────────────────────────────────────────────────

test('stdout/stderr truncated to 2048 chars in commandResults', () => {
  const longOut = 'x'.repeat(10000);
  safeSpawn.mockReturnValue({ success: true, status: 0, duration: 50, timedOut: false, stdout: longOut, stderr: '' });
  const result = runVerification(['npm test'], '/project');
  expect(result.commandResults[0].stdout.length).toBe(2048);
});
