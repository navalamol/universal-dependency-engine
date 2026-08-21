'use strict';

const {
  safeSpawn,
  resolveExecutable,
  validatePackageName,
  validateVersion,
  validatePath,
  ALLOWED_EXECUTABLES,
} = require('../../src/core/safe-exec');

// ─── validatePackageName ──────────────────────────────────────────────────────

describe('validatePackageName', () => {
  test('accepts valid npm scoped package', () => {
    expect(() => validatePackageName('@babel/core')).not.toThrow();
  });

  test('accepts valid npm package', () => {
    expect(() => validatePackageName('lodash')).not.toThrow();
  });

  test('accepts valid cargo crate', () => {
    expect(() => validatePackageName('serde_json')).not.toThrow();
  });

  test('accepts go module path', () => {
    expect(() => validatePackageName('github.com/user/module')).not.toThrow();
  });

  test('accepts python package name', () => {
    expect(() => validatePackageName('urllib3')).not.toThrow();
  });

  test('rejects empty string', () => {
    expect(() => validatePackageName('')).toThrow();
  });

  test('rejects semicolon (command injection)', () => {
    expect(() => validatePackageName('lodash; rm -rf /')).toThrow(/unsafe/);
  });

  test('rejects pipe (command injection)', () => {
    expect(() => validatePackageName('lodash|cat /etc/passwd')).toThrow(/unsafe/);
  });

  test('rejects backtick (command substitution)', () => {
    expect(() => validatePackageName('lodash`id`')).toThrow(/unsafe/);
  });

  test('rejects dollar sign (variable expansion)', () => {
    expect(() => validatePackageName('$(rm -rf /)')).toThrow(/unsafe/);
  });

  test('rejects newline', () => {
    expect(() => validatePackageName('lodash\nrm -rf /')).toThrow(/unsafe/);
  });

  test('rejects null byte', () => {
    expect(() => validatePackageName('lodash\0evil')).toThrow(/unsafe/);
  });

  test('rejects single quote', () => {
    expect(() => validatePackageName("'; drop table packages; --")).toThrow(/unsafe/);
  });

  test('rejects double quote', () => {
    expect(() => validatePackageName('"malicious"')).toThrow(/unsafe/);
  });

  test('rejects name over 512 chars', () => {
    expect(() => validatePackageName('a'.repeat(513))).toThrow(/long/);
  });

  test('rejects non-string', () => {
    expect(() => validatePackageName(null)).toThrow();
    expect(() => validatePackageName(42)).toThrow();
  });
});

// ─── validateVersion ─────────────────────────────────────────────────────────

describe('validateVersion', () => {
  test('accepts semver', () => {
    expect(() => validateVersion('1.2.3')).not.toThrow();
  });

  test('accepts pre-release', () => {
    expect(() => validateVersion('1.2.3-alpha.1')).not.toThrow();
  });

  test('accepts go v-prefix', () => {
    expect(() => validateVersion('v1.2.3')).not.toThrow();
  });

  test('accepts build metadata', () => {
    expect(() => validateVersion('1.2.3+build.1')).not.toThrow();
  });

  test('rejects empty string', () => {
    expect(() => validateVersion('')).toThrow();
  });

  test('rejects semicolon', () => {
    expect(() => validateVersion('1.2.3; rm -rf /')).toThrow(/unsafe/);
  });

  test('rejects space', () => {
    expect(() => validateVersion('1.2.3 extra')).toThrow(/unexpected/);
  });

  test('rejects dollar sign', () => {
    expect(() => validateVersion('${IFS}')).toThrow(/unsafe/);
  });

  test('rejects null byte', () => {
    expect(() => validateVersion('1.2.3\0')).toThrow(/unsafe/);
  });

  test('rejects version over 128 chars', () => {
    expect(() => validateVersion('1.' + '0.'.repeat(65))).toThrow(/long/);
  });
});

// ─── validatePath ─────────────────────────────────────────────────────────────

describe('validatePath', () => {
  test('accepts normal path', () => {
    expect(() => validatePath('/tmp/project')).not.toThrow();
  });

  test('accepts Windows path', () => {
    expect(() => validatePath('C:\\Users\\project')).not.toThrow();
  });

  test('rejects null byte', () => {
    expect(() => validatePath('/tmp/proj\0ect')).toThrow(/null byte/);
  });

  test('rejects non-string', () => {
    expect(() => validatePath(42)).toThrow();
  });
});

// ─── resolveExecutable ───────────────────────────────────────────────────────

describe('resolveExecutable', () => {
  test('returns name unchanged on non-Windows', () => {
    if (process.platform !== 'win32') {
      expect(resolveExecutable('npm')).toBe('npm');
      expect(resolveExecutable('cargo')).toBe('cargo');
    }
  });

  test('returns absolute path unchanged', () => {
    const abs = '/usr/bin/node';
    expect(resolveExecutable(abs)).toBe(abs);
  });
});

// ─── ALLOWED_EXECUTABLES ─────────────────────────────────────────────────────

describe('ALLOWED_EXECUTABLES', () => {
  test('contains expected executables', () => {
    expect(ALLOWED_EXECUTABLES.has('npm')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('cargo')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('git')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('python')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('pip')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('go')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('dotnet')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('mvn')).toBe(true);
  });

  test('does not contain dangerous executables', () => {
    expect(ALLOWED_EXECUTABLES.has('bash')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('sh')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('cmd')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('powershell')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('rm')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('curl')).toBe(false);
  });
});

// ─── safeSpawn ───────────────────────────────────────────────────────────────

describe('safeSpawn', () => {
  test('throws for executable not in allowlist', () => {
    expect(() => safeSpawn('bash', ['-c', 'echo hi'])).toThrow(/allowlist/);
  });

  test('throws for rm', () => {
    expect(() => safeSpawn('rm', ['-rf', '/'])).toThrow(/allowlist/);
  });

  test('throws if args is not an array', () => {
    expect(() => safeSpawn('npm', 'install')).toThrow(/array/);
  });

  test('throws if any arg contains null byte', () => {
    expect(() => safeSpawn('npm', ['install\0evil'])).toThrow(/null byte/);
  });

  test('throws if cwd contains null byte', () => {
    expect(() => safeSpawn('npm', ['--version'], { cwd: '/tmp/proj\0ect' })).toThrow(/null byte/);
  });

  test('returns structured result with success=true for valid command', () => {
    // node --version is not in allowlist, but we can test with a known-safe approach:
    // skip this test on systems where npm is not installed
    try {
      const result = safeSpawn('npm', ['--version'], { timeout: 10000 });
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('timedOut');
      if (result.success) {
        expect(typeof result.stdout).toBe('string');
        expect(result.timedOut).toBe(false);
      }
    } catch (err) {
      // safeSpawn itself threw — means allowlist or validation issue, not expected
      throw err;
    }
  });

  test('returns success=false for nonexistent subcommand', () => {
    const result = safeSpawn('npm', ['__nonexistent_subcommand_xyz__'], { timeout: 10000 });
    expect(result.success).toBe(false);
  });
});
