import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { appendFile, cp, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

type DiagnosticHooks = Pick<WebdriverIO.Config, 'outputDir' | 'beforeSession' | 'before' | 'after'>;

interface NativePaths {
  crashDumps: string;
}

type NativeInstaller = (
  app: unknown,
  fileSystem: unknown,
  nativeProcess: unknown,
  logFile: string,
) => NativePaths;

interface NativeRemote {
  app: unknown;
  process: unknown;
  require(module: 'node:fs'): unknown;
  require(module: 'node:vm'): {
    runInThisContext(source: string, options: { filename: string }): NativeInstaller;
  };
}

// Keep callbacks in the main process: renderer callbacks sent over remote cannot
// report the death of their own renderer. The source is fixed; paths are arguments.
// https://github.com/electron/remote#passing-callbacks-to-the-main-process
// https://github.com/nodejs/node/blob/v18.18.2/doc/api/vm.md#vmruninthiscontextcode-options
const MAIN_OBSERVER_SOURCE = String.raw`((app, fileSystem, nativeProcess, logFile) => {
  const key = Symbol.for('abyss.e2e.nativeCrashDiagnostics');
  if (app[key] !== undefined) return app[key];
  const append = (event, details) => {
    try {
      fileSystem.appendFileSync(logFile, JSON.stringify({
        timestamp: new Date().toISOString(), event, ...details,
      }) + '\n');
    } catch (error) {
      console.error('Native crash diagnostics could not write a record:', error);
    }
  };
  app.on('render-process-gone', (_event, contents, details) => {
    append('render-process-gone', {
      webContentsId: contents.id, reason: details.reason, exitCode: details.exitCode,
    });
  });
  app.on('child-process-gone', (_event, details) => {
    append('child-process-gone', {
      processType: details.type, reason: details.reason, exitCode: details.exitCode,
    });
  });
  const paths = { crashDumps: app.getPath('crashDumps') };
  app[key] = paths;
  append('runtime', { versions: nativeProcess.versions });
  try {
    append('gpu-feature-status', { status: app.getGPUFeatureStatus() });
    app.getGPUInfo('complete').then(
      (info) => append('gpu-info', { info }),
      (error) => append('gpu-info-error', { message: String(error) }),
    );
  } catch (error) {
    append('gpu-info-error', { message: String(error) });
  }
  return paths;
})`;

function standaloneCapabilities(value: unknown): WebdriverIO.Capabilities | null {
  if (typeof value !== 'object' || value === null) return null;
  if ('alwaysMatch' in value) return standaloneCapabilities(value.alwaysMatch);
  if ('browserName' in value && typeof value.browserName === 'string') {
    return value as WebdriverIO.Capabilities;
  }
  return null;
}

async function installMainObserver(session: WebdriverIO.Browser, logFile: string): Promise<string> {
  // WDIO runs config and service hooks together; the service may still be preparing Obsidian.
  await session.waitUntil(
    () =>
      session.execute(() => {
        const host = window as Window & { electron?: { remote?: NativeRemote } };
        return host.electron?.remote !== undefined;
      }),
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'The native Obsidian remote bridge is unavailable.',
    },
  );
  return session.execute(
    (source, destination) => {
      const host = window as Window & { electron?: { remote?: NativeRemote } };
      const remote = host.electron?.remote;
      if (remote === undefined)
        throw new Error('The native Obsidian remote bridge is unavailable.');
      const install = remote.require('node:vm').runInThisContext(source, {
        filename: 'abyss-e2e-native-crash-diagnostics.cjs',
      });
      const installed = install(remote.app, remote.require('node:fs'), remote.process, destination);
      // Return a plain value rather than asking WebDriver to serialize a remote proxy.
      return installed.crashDumps;
    },
    MAIN_OBSERVER_SOURCE,
    logFile,
  );
}

export function createNativeCrashDiagnostics(directory: string | undefined): DiagnosticHooks {
  if (process.platform !== 'win32' || directory === undefined || directory.trim().length === 0) {
    return {};
  }
  const root = path.resolve(directory);
  const outputDir = path.join(root, 'wdio');
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    console.warn('Native crash diagnostics could not create the output directory:', error);
    return {};
  }
  let workerDirectory: string | null = null;
  let crashDumpsDirectory: string | null = null;

  const reportFailure = async (stage: string, error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Native crash diagnostics ${stage}: ${message}`);
    if (workerDirectory === null) return;
    try {
      await appendFile(
        path.join(workerDirectory, 'collection-errors.jsonl'),
        `${JSON.stringify({ timestamp: new Date().toISOString(), stage, message })}\n`,
      );
    } catch (writeError) {
      console.warn('Native crash diagnostics could not record a collection error:', writeError);
    }
  };

  return {
    outputDir,
    async beforeSession(_config, requestedCapabilities, _specs, cid) {
      const capabilities = standaloneCapabilities(requestedCapabilities);
      if (capabilities === null) return;
      try {
        const destination = path.join(root, cid);
        await mkdir(destination, { recursive: true });
        workerDirectory = destination;
        const binary = capabilities['goog:chromeOptions']?.binary;
        if (typeof binary === 'string') {
          try {
            await promisify(execFile)(
              'pwsh',
              [
                '-NoProfile',
                '-NonInteractive',
                '-File',
                path.join(import.meta.dirname, 'prepare-windows-sandbox.ps1'),
                '-Installer',
                binary,
                '-RepoRoot',
                path.resolve(import.meta.dirname, '../..'),
                '-ReportPath',
                path.join(destination, 'sandbox-acl.json'),
              ],
              { windowsHide: true, timeout: 30_000 },
            );
          } catch (error) {
            await reportFailure('sandbox ACL preparation failed', error);
          }
        }
        const driverLoggingOptions = {
          ...capabilities['wdio:chromedriverOptions'],
          verbose: true,
          logPath: path.join(destination, 'chromedriver.log'),
          appendLog: true,
          readableTimestamp: true,
        };
        capabilities['wdio:chromedriverOptions'] = driverLoggingOptions;
        // Electron 28 cannot reliably send Windows child-process logs to stderr.
        // https://github.com/electron/electron/blob/v28.2.3/docs/api/command-line-switches.md#--enable-loggingfile
        capabilities['goog:chromeOptions'] = {
          ...capabilities['goog:chromeOptions'],
          args: [
            ...(capabilities['goog:chromeOptions']?.args ?? []),
            '--enable-logging=file',
            `--log-file=${path.join(destination, 'electron.log')}`,
            '--log-level=0',
            '--v=1',
          ],
        };
      } catch (error) {
        await reportFailure('startup logging failed', error);
      }
    },
    async before(_capabilities, _specs, session: WebdriverIO.Browser) {
      if (workerDirectory === null) return;
      try {
        const crashDumps = await installMainObserver(
          session,
          path.join(workerDirectory, 'native-processes.jsonl'),
        );
        if (typeof crashDumps !== 'string' || !path.isAbsolute(crashDumps)) {
          throw new Error('Electron did not return an absolute crash dumps directory.');
        }
        crashDumpsDirectory = crashDumps;
        await writeFile(
          path.join(workerDirectory, 'crash-dumps.json'),
          `${JSON.stringify({ source: crashDumps })}\n`,
        );
      } catch (error) {
        await reportFailure('main-process observer failed', error);
      }
    },
    async after() {
      if (workerDirectory === null || crashDumpsDirectory === null) return;
      try {
        // The service deletes its temporary profiles in afterSession. Preserve any
        // existing dumps while the profile exists; never start or reconfigure reporting.
        // https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/3.3.0/packages/wdio-obsidian-service/src/service.ts#L747
        await cp(crashDumpsDirectory, path.join(workerDirectory, 'crashDumps'), {
          recursive: true,
        }).catch(async (error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          if (workerDirectory === null) return;
          await writeFile(
            path.join(workerDirectory, 'crash-dumps-unavailable.json'),
            `${JSON.stringify({ message: error.message })}\n`,
          );
        });
      } catch (error) {
        await reportFailure('crash dump collection failed', error);
      }
    },
  };
}
