import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { isString } from '../shared/guards.js';
import {
  createWindowsPowerShellResolver,
  getStablePowerShell7Directories,
} from './windows-powershell.js';

const PROGRAM_FILES = 'C:\\Program Files';
const LOCAL_APPDATA = 'C:\\Users\\Ada\\AppData\\Local';
const USER_PROFILE = 'C:\\Users\\Ada';
const WINDOWS_APPS = `${LOCAL_APPDATA}\\Microsoft\\WindowsApps`;
const STABLE_7_DIR = `${PROGRAM_FILES}\\PowerShell\\7`;
const USER_STABLE_7_DIR = `${LOCAL_APPDATA}\\Microsoft\\PowerShell\\7`;
const STABLE_7_PREVIEW_DIR = `${PROGRAM_FILES}\\PowerShell\\7-preview`;
const STABLE_7_EXE = `${STABLE_7_DIR}\\pwsh.exe`;
const USER_STABLE_7_EXE = `${USER_STABLE_7_DIR}\\pwsh.exe`;
const STABLE_7_PREVIEW_EXE = `${STABLE_7_PREVIEW_DIR}\\pwsh.exe`;
const SYSTEM_PATH = 'C:\\Windows\\System32';
const SYSTEM_PWSH = `${SYSTEM_PATH}\\pwsh.exe`;
const SYSTEM_POWERSHELL = `${SYSTEM_PATH}\\powershell.exe`;
const ALIAS_PWSH = `${WINDOWS_APPS}\\pwsh.exe`;
const VERSIONED_TARGET = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\\pwsh.exe';

const probeOutput = (version, executable) => `${version}|${executable}`;

// PATHEXT is lowercase here so the fixture paths can spell `.exe`; the resolver
// uses whatever the environment carries, in its order.
const baseEnv = (overrides = {}) => ({
  PATH: SYSTEM_PATH,
  ProgramFiles: PROGRAM_FILES,
  LOCALAPPDATA: LOCAL_APPDATA,
  USERPROFILE: USER_PROFILE,
  SystemRoot: 'C:\\Windows',
  PATHEXT: '.com;.exe;.bat;.cmd',
  ...overrides,
});

// Keys are the absolute executable handed to spawnSync. `files` is the set the
// injected `statSync` reports as files, which is what `which` decides on: an
// app-execution alias rejects that stat while still being launchable.
const createProbeStub = (executables) => {
  const calls = [];
  const spawnSync = (executable, _args, options) => {
    calls.push({ executable, pathValue: String(options?.env?.PATH ?? '') });

    const entry = executables[executable];
    if (entry instanceof Error) throw entry;

    const output = entry instanceof Function
      ? entry(options)
      : (isString(entry) ? entry : null);
    if (!isString(output)) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: `${output}\n`, stderr: '' };
  };
  return { spawnSync, calls };
};

const createResolver = (executables, { env = baseEnv(), platform = 'win32', files } = {}) => {
  const stub = createProbeStub(executables);
  const fileSet = new Set(files ?? Object.keys(executables).filter((key) => !(executables[key] instanceof Error)));
  const fsStub = {
    statSync(candidate) {
      if (fileSet.has(candidate)) return { isFile: () => true };
      const error = new Error(`ENOENT: ${candidate}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
  const resolver = createWindowsPowerShellResolver({
    env,
    platform,
    path: path.win32,
    fs: fsStub,
    spawnSync: stub.spawnSync,
  });
  return { ...stub, resolver, files: fileSet };
};

describe('getStablePowerShell7Directories', () => {
  it('lists the named PowerShell 7 install directories on Windows, preview last', () => {
    const directories = getStablePowerShell7Directories({ env: baseEnv(), platform: 'win32', path: path.win32 });
    expect(directories).toEqual([STABLE_7_DIR, USER_STABLE_7_DIR, STABLE_7_PREVIEW_DIR]);
  });

  it('lists nothing off Windows', () => {
    expect(getStablePowerShell7Directories({ env: baseEnv(), platform: 'linux', path: path.win32 })).toEqual([]);
  });
});

describe('createWindowsPowerShellResolver', () => {
  it('answers nothing off Windows', () => {
    const { resolver } = createResolver({}, { platform: 'linux' });
    expect(resolver.getStableDirectory()).toBeNull();
    expect(resolver.describe({ managedPath: SYSTEM_PATH })).toBeNull();
  });

  it('keeps a stable directory only when the binary verifies as PowerShell 7', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_DIR);
  });

  it('treats an existing directory whose binary is not PowerShell 7 as absent', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('5.1.26100.9549', SYSTEM_POWERSHELL),
    });

    expect(resolver.getStableDirectory()).toBeNull();
  });

  it('ignores a stable candidate that is not a file `which` could see', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    }, { files: [] });

    expect(resolver.getStableDirectory()).toBeNull();
  });

  it('accepts a preview build as PowerShell 7 when nothing else verifies', () => {
    const { resolver } = createResolver({
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.5.0-preview.4', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_PREVIEW_DIR);
  });

  it('skips a stable candidate that cannot be spawned', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: new Error('EACCES'),
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.6.0', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_PREVIEW_DIR);
  });

  it('prefers a stable channel install over a newer preview build', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.2.24', STABLE_7_EXE),
      [USER_STABLE_7_EXE]: probeOutput('7.6.7', USER_STABLE_7_EXE),
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.9.0', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(USER_STABLE_7_DIR);
  });

  it('reports Windows PowerShell 5.1 and a downgrade when the alias rejects `which`', () => {
    // The state from #4895: pwsh 7 exists behind the Store alias, but the alias
    // rejects statSync, so OpenCode's lookup falls through to 5.1.
    const { resolver, files } = createResolver({
      [ALIAS_PWSH]: probeOutput('7.6.7', VERSIONED_TARGET),
      [SYSTEM_POWERSHELL]: probeOutput('5.1.26100.9549', SYSTEM_POWERSHELL),
    }, { files: [SYSTEM_POWERSHELL] });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(files.has(ALIAS_PWSH)).toBe(false);
    expect(report.diagnostics.effectivePath).toBe(SYSTEM_POWERSHELL);
    expect(report.diagnostics.effectiveVersion).toBe('5.1.26100.9549');
    expect(report.diagnostics.pwshVersion).toBe('7.6.7');
    expect(report.diagnostics.pwshPath).toBe(VERSIONED_TARGET);
    expect(report.diagnostics.downgrade).toBe(true);
    expect(report.warning).toContain('Windows PowerShell 5.1');
    expect(report.warning).toContain('ANSI code page');
  });

  it('honours SHELL before pwsh and powershell', () => {
    const shell = 'D:\\tools\\pwsh-preview\\pwsh.exe';
    const { resolver } = createResolver({
      [shell]: probeOutput('7.7.0', shell),
      [SYSTEM_PWSH]: probeOutput('7.6.7', SYSTEM_PWSH),
    }, { env: baseEnv({ SHELL: shell }), files: [shell, SYSTEM_PWSH] });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.effectivePath).toBe(shell);
    expect(report.diagnostics.effectiveVersion).toBe('7.7.0');
    expect(report.diagnostics.downgrade).toBe(false);
  });

  it('reports a SHELL that is not PowerShell instead of naming a PowerShell it will not use', () => {
    const shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const { resolver } = createResolver({
      [SYSTEM_PWSH]: probeOutput('7.6.7', SYSTEM_PWSH),
    }, { env: baseEnv({ SHELL: shell }), files: [shell, SYSTEM_PWSH] });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.effectivePath).toBe(shell);
    expect(report.diagnostics.effectiveVersion).toBeNull();
    expect(report.diagnostics.downgrade).toBe(false);
    expect(report.summary).toContain(shell);
  });

  it('reports the versioned Store target when the alias is visible to `which`', () => {
    const { resolver } = createResolver({
      [ALIAS_PWSH]: probeOutput('7.6.7', VERSIONED_TARGET),
    }, { files: [ALIAS_PWSH] });

    const report = resolver.describe({ managedPath: [WINDOWS_APPS, SYSTEM_PATH].join(';') });

    expect(report.diagnostics.effectivePath).toBe(VERSIONED_TARGET);
    expect(report.diagnostics.downgrade).toBe(false);
    expect(report.summary).toContain(VERSIONED_TARGET);
  });

  it('reports the stable install once it is in front of the managed PATH', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    const report = resolver.describe({ managedPath: [STABLE_7_DIR, SYSTEM_PATH].join(';') });

    expect(report.diagnostics).toMatchObject({
      insertedDirectory: STABLE_7_DIR,
      pwshPath: STABLE_7_EXE,
      pwshVersion: '7.6.7',
      effectivePath: STABLE_7_EXE,
      effectiveVersion: '7.6.7',
      downgrade: false,
    });
    expect(report.warning).toBeNull();
  });

  it('stays silent on a machine whose only interpreter is Windows PowerShell 5.1', () => {
    const { resolver } = createResolver({
      [SYSTEM_POWERSHELL]: probeOutput('5.1.26100.9549', SYSTEM_POWERSHELL),
    });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.downgrade).toBe(false);
    expect(report.diagnostics.pwshPath).toBeNull();
    expect(report.warning).toBeNull();
    expect(report.summary).toContain('Windows PowerShell 5.1.26100.9549');
  });

  it('falls through a candidate that stats but does not answer', () => {
    const { resolver } = createResolver({
      [SYSTEM_PWSH]: '',
      [SYSTEM_POWERSHELL]: probeOutput('5.1.26100.9549', SYSTEM_POWERSHELL),
    }, { files: [SYSTEM_PWSH, SYSTEM_POWERSHELL] });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.effectivePath).toBe(SYSTEM_POWERSHELL);
  });

  it('does not probe again for a PATH it already answered', () => {
    const { resolver, calls } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    resolver.describe({ managedPath: SYSTEM_PATH });
    const afterFirst = calls.length;
    resolver.describe({ managedPath: SYSTEM_PATH });

    expect(calls.length).toBe(afterFirst);
  });
});
