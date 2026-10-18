import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isString } from '../shared/guards.js';
import { getWindowsAppsDirectory } from '../tunnels/executable-search.js';

// Resolving the Windows PowerShell interpreter the managed OpenCode shell will
// use, and finding a PowerShell 7 install whose path does not change under the
// user's feet (#4895).
//
// The failure this file exists for: a Store-installed PowerShell 7 is only
// reachable through an app-execution alias under
// `%LOCALAPPDATA%\Microsoft\WindowsApps`, a 0-byte reparse point. OpenCode picks
// its shell with `which`, which rejects every candidate `statSync` does not
// report as a file, so the alias is invisible to it and the shell falls back to
// Windows PowerShell 5.1. Where the versioned package folder does reach the
// PATH, the command it spawns embeds the package version, and a Store upgrade
// renames it. That resolution and the cache behind it belong to the OpenCode
// server; what this module can do is report the interpreter OpenCode will
// actually run, and put a pwsh whose path never changes in front of the rest.

// An interpreter is verified by running it, never by its path existing: a
// half-removed MSI, a quarantined file and a stale reparse target all sit at a
// path that looks right. A healthy PowerShell answers in well under a second,
// so a probe that overruns is abandoned rather than holding the server's event
// loop, and the whole resolution stops once its budget is spent.
const WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_POWERSHELL_PROBE_BUDGET_MS = 5_000;
const MINIMUM_POWERSHELL_MAJOR = 7;
const DEFAULT_PATH_EXTENSIONS = '.COM;.EXE;.BAT;.CMD';

// Version and the executable that actually ran. `Get-Process` reports the real
// module path, so a Store alias shows the versioned target behind it rather
// than the alias that was called.
const VERSION_PROBE_COMMAND = '[Console]::Out.Write("$($PSVersionTable.PSVersion)|$((Get-Process -Id $PID -ErrorAction SilentlyContinue).Path)")';
const VERSION_PROBE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_PROBE_COMMAND];

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (isString(value) && value.trim()) return value.trim();
  }
  return '';
};

/**
 * Directories a PowerShell 7 install lives in and keeps its name across a Store
 * upgrade. A Store install has no such directory, which is why a machine that
 * only has the Store build cannot be helped by PATH alone. The preview build
 * comes last: it is only a candidate when no stable install verifies.
 */
export const getStablePowerShell7Directories = ({ env = process.env, platform = process.platform, path: pathApi = path } = {}) => {
  if (platform !== 'win32') return [];

  const programFiles = firstNonEmpty(env.ProgramFiles, env.PROGRAMFILES, env.programfiles) || 'C:\\Program Files';
  const localAppData = firstNonEmpty(env.LOCALAPPDATA, env.LocalAppData, env.localappdata);

  const directories = [pathApi.join(programFiles, 'PowerShell', '7')];
  if (localAppData) {
    directories.push(pathApi.join(localAppData, 'Microsoft', 'PowerShell', '7'));
  }
  directories.push(pathApi.join(programFiles, 'PowerShell', '7-preview'));
  return directories;
};

const parseVersionProbeOutput = (raw) => {
  const text = isString(raw) ? raw.trim() : '';
  if (!text) return null;

  const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop();
  if (!line) return null;

  const [versionText = '', executableText = ''] = line.split('|');
  const version = versionText.trim();
  // A preview build answers with a version like `7.5.0-preview.4`, which is a
  // usable PowerShell 7 and must not be read as "no interpreter".
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.]+)?$/.test(version)) return null;

  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) return null;

  return {
    version,
    major,
    executable: executableText.trim() || null,
  };
};

const versionParts = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);

const isNewerVersion = (candidate, current) => {
  const left = versionParts(candidate);
  const right = versionParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const pathExtensions = (env) => firstNonEmpty(env.PATHEXT, env.PathExt, env.pathext) || DEFAULT_PATH_EXTENSIONS;

const isSeparatedPath = (value) => value.includes('/') || value.includes('\\');

export const createWindowsPowerShellResolver = ({
  env = process.env,
  platform = process.platform,
  path: pathApi = path,
  fs: fsApi = fs,
  spawnSync: runSpawnSync = spawnSync,
  timeoutMs = WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS,
} = {}) => {
  // Probing costs a process, so one result per executable and PATH is kept for
  // the life of the resolver. The managed server can restart many times in one
  // app run and must not pay for the same answer again.
  const probeCache = new Map();
  let stableResolved = false;
  let stableDirectory = null;
  let stableProbe = null;
  const reportCache = new Map();

  const probe = (executable, pathValue) => {
    const key = `${executable}\u0000${pathValue ?? ''}`;
    if (probeCache.has(key)) return probeCache.get(key);

    let result = null;
    try {
      const spawned = runSpawnSync(executable, VERSION_PROBE_ARGS, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
        env: { ...env, PATH: pathValue, Path: pathValue, path: pathValue },
      });
      if (spawned && spawned.status === 0) {
        result = parseVersionProbeOutput(spawned.stdout);
      }
    } catch {
      result = null;
    }

    probeCache.set(key, result);
    return result;
  };

  // `statSync` is what decides whether OpenCode can see a candidate at all: its
  // shell picker is `which`, and a Store app-execution alias rejects that stat
  // with EACCES even though CreateProcess can launch it.
  const isFilePath = (candidate) => {
    try {
      return fsApi.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  // npm `which` on Windows: for every PATH directory try the name with each
  // PATHEXT entry, then the bare name, and keep the first one that stats as a
  // file. The WindowsApps directory is deliberately not appended here, because
  // `which` does not look there.
  const whichFilePath = (name, pathValue) => {
    const extensions = path.extname(name) ? [''] : pathExtensions(env).split(';').map((ext) => {
      const trimmed = ext.trim();
      if (!trimmed) return '';
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    }).filter(Boolean);
    const candidateNames = [...extensions.map((ext) => `${name}${ext}`), name];

    for (const directory of String(pathValue).split(pathApi.delimiter)) {
      if (!directory) continue;
      for (const candidateName of candidateNames) {
        const candidate = pathApi.join(directory, candidateName);
        if (isFilePath(candidate)) return candidate;
      }
    }
    return null;
  };

  const resolveCommand = (name, pathValue) => {
    const trimmed = firstNonEmpty(name);
    if (!trimmed) return null;
    return isSeparatedPath(trimmed) ? (isFilePath(trimmed) ? trimmed : null) : whichFilePath(trimmed, pathValue);
  };

  // The PATH the resolver reports against when the caller has none of its own.
  const defaultPathValue = () => firstNonEmpty(env.PATH, env.Path, env.path);

  // A PowerShell 7 this machine has whatever the managed PATH reaches. The alias
  // directory comes from the user profile rather than from LOCALAPPDATA on
  // purpose: the managed PATH is built from LOCALAPPDATA, so asking that same
  // source twice could never disagree and the warning below could never fire.
  const userAliasCandidates = () => {
    const userProfile = firstNonEmpty(env.USERPROFILE, env.UserProfile, env.userprofile);
    const directory = getWindowsAppsDirectory(userProfile ? { USERPROFILE: userProfile } : {});
    return directory ? [pathApi.join(directory, 'pwsh.exe')] : [];
  };

  const newestVerified = (directories, deadline) => {
    let best = null;
    for (const directory of directories) {
      if (Date.now() > deadline) break;
      const executable = pathApi.join(directory, 'pwsh.exe');
      if (!isFilePath(executable)) continue;
      const probed = probe(executable, defaultPathValue());
      if (!probed || probed.major < MINIMUM_POWERSHELL_MAJOR) continue;
      if (!best || isNewerVersion(probed.version, best.probe.version)) {
        best = { directory, probe: probed };
      }
    }
    return best;
  };

  // The stable install to prepend, verified by running it. A stable channel
  // install always wins over a preview build, even a newer one: the preview is
  // only there for machines that have nothing else. Within a channel the newest
  // wins, so a leftover older install never shadows a newer sibling.
  const resolveStable = () => {
    if (platform !== 'win32') return null;
    if (stableResolved) return stableDirectory ? { directory: stableDirectory, probe: stableProbe } : null;
    stableResolved = true;

    const deadline = Date.now() + WINDOWS_POWERSHELL_PROBE_BUDGET_MS;
    const directories = getStablePowerShell7Directories({ env, platform, path: pathApi });
    const preview = directories.filter((directory) => /-preview$/i.test(directory));
    const stable = directories.filter((directory) => !/-preview$/i.test(directory));
    const chosen = newestVerified(stable, deadline) ?? newestVerified(preview, deadline);

    if (chosen) {
      stableDirectory = chosen.directory;
      stableProbe = chosen.probe;
    }
    return stableDirectory ? { directory: stableDirectory, probe: stableProbe } : null;
  };

  /**
   * What the shell runs, resolved the way OpenCode resolves it: `SHELL` first,
   * then `which` for `pwsh` and `powershell`.
   */
  const resolveEffective = (pathValue, deadline) => {
    const names = [];
    const shell = firstNonEmpty(env.SHELL, env.shell);
    if (shell) names.push({ name: shell, fromShell: true });
    names.push({ name: 'pwsh' }, { name: 'powershell' });

    for (const entry of names) {
      if (Date.now() > deadline) return null;
      const executable = resolveCommand(entry.name, pathValue);
      if (!executable) continue;
      const probed = probe(executable, pathValue);
      if (probed) return { executable, probe: probed };
      // A `SHELL` that resolves but does not answer like PowerShell is still
      // what the shell will run, and saying so is more honest than naming a
      // PowerShell the shell does not use.
      if (entry.fromShell) return { executable, probe: null };
    }
    return null;
  };

  /**
   * What the managed shell will run, given the PATH OpenChamber hands it.
   *
   * `installed` is a PowerShell 7 this machine has: the one the managed PATH
   * already resolves, or a stable install, or the Store alias under the user's
   * own profile. `effective` is what OpenCode's own lookup reaches. The two
   * differ when PowerShell 7 exists only behind an alias `which` cannot stat,
   * which is the case worth naming in a warning.
   */
  const describe = ({ managedPath } = {}) => {
    if (platform !== 'win32') return null;

    const effectivePathValue = isString(managedPath) && managedPath ? managedPath : defaultPathValue();
    if (reportCache.has(effectivePathValue)) return reportCache.get(effectivePathValue);

    const deadline = Date.now() + WINDOWS_POWERSHELL_PROBE_BUDGET_MS;
    const stable = resolveStable();
    const effective = resolveEffective(effectivePathValue, deadline);
    const effectiveProbe = effective ? effective.probe : null;

    const installedProbe = (() => {
      if (effectiveProbe && effectiveProbe.major >= MINIMUM_POWERSHELL_MAJOR) return effectiveProbe;
      if (stable && stable.probe) return stable.probe;
      // The alias rejects `statSync`, so this one is probed by running it.
      for (const candidate of userAliasCandidates()) {
        if (Date.now() > deadline) return null;
        const probed = probe(candidate, effectivePathValue);
        if (probed && probed.major >= MINIMUM_POWERSHELL_MAJOR) return probed;
      }
      return null;
    })();

    const lagsPowerShell7 = effectiveProbe !== null && effectiveProbe.major < MINIMUM_POWERSHELL_MAJOR;
    const downgrade = installedProbe !== null && lagsPowerShell7;
    const label = (probeResult) => (probeResult.major >= MINIMUM_POWERSHELL_MAJOR
      ? `PowerShell ${probeResult.version}`
      : `Windows PowerShell ${probeResult.version}`);
    const effectiveLabel = effectiveProbe
      ? label(effectiveProbe)
      : 'no PowerShell interpreter';
    const warning = !downgrade
      ? null
      : `The OpenCode shell runs ${effectiveLabel}, but this machine has ${label(installedProbe)} at `
        + `${installedProbe.executable || '<unknown>'}.`
        + (effectiveProbe.major <= 5
          ? ' Windows PowerShell 5.1 reads and writes files with the system ANSI code page,'
            + ' so commands that touch UTF-8 files can corrupt them.'
          : '');

    const report = {
      summary: effectiveProbe
        ? `Shell interpreter: ${effectiveLabel} at ${effectiveProbe.executable || '<unknown>'}`
        : effective
          ? `Shell interpreter: ${effective.executable}, which does not report a PowerShell version`
          : 'Shell interpreter: none found, PowerShell commands will not run',
      warning,
      diagnostics: {
        insertedDirectory: stable ? stable.directory : null,
        pwshPath: installedProbe ? installedProbe.executable : null,
        pwshVersion: installedProbe ? installedProbe.version : null,
        // The path that actually ran, which for a Store alias is the versioned
        // target behind it: that is the string a Store upgrade breaks.
        effectivePath: effectiveProbe && effectiveProbe.executable
          ? effectiveProbe.executable
          : (effective ? effective.executable : null),
        effectiveVersion: effectiveProbe ? effectiveProbe.version : null,
        downgrade,
      },
    };

    reportCache.set(effectivePathValue, report);
    return report;
  };

  return {
    getStableDirectory: () => (resolveStable() ? stableDirectory : null),
    describe,
  };
};
