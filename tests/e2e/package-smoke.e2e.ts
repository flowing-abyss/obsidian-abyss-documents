import { $, browser, expect } from '@wdio/globals';
import { after, before, describe, it } from 'mocha';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';

const pluginDirectory = env['ABYSS_PACKAGE_PLUGIN_DIR'];
if (pluginDirectory === undefined) throw new Error('Missing ABYSS_PACKAGE_PLUGIN_DIR.');
const manifest = JSON.parse(readFileSync(path.join(pluginDirectory, 'manifest.json'), 'utf8')) as {
  readonly id: string;
  readonly version: string;
};

interface RuntimeMetrics {
  readonly counters: {
    readonly pdfRuntimeLoads: number;
    readonly workerUrlsActive: number;
  };
  readonly versions: { readonly pdfjs: string | null; readonly plugin: string | null };
}

async function metrics(): Promise<RuntimeMetrics> {
  return browser.execute(() => {
    const host = window as Window & {
      __abyssDocumentsPerformance?: RuntimeMetrics;
    };
    if (host.__abyssDocumentsPerformance === undefined) {
      throw new Error('Reader instrumentation was not published.');
    }
    return host.__abyssDocumentsPerformance;
  });
}

describe('Community installer package smoke', () => {
  before(async () => {
    await browser.execute(() => {
      const host = window as Window & {
        __abyssNetworkSmoke?: {
          attempts: number;
          details: Array<{ kind: string; stack: string; url: string }>;
          restore: () => void;
        };
      };
      const originalFetch = window.fetch.bind(window);
      const originalXhrOpen = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'open');
      if (originalXhrOpen === undefined) throw new Error('XMLHttpRequest.open is unavailable.');
      const originalXhrOpenValue: unknown = originalXhrOpen.value;
      if (typeof originalXhrOpenValue !== 'function') {
        throw new Error('XMLHttpRequest.open is not callable.');
      }
      const callOriginalXhrOpen = originalXhrOpenValue as (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
      ) => void;
      const isLocalUrl = (value: string): boolean => {
        const protocol = new URL(value, window.location.href).protocol;
        return ['app:', 'blob:', 'data:', 'file:'].includes(protocol);
      };
      host.__abyssNetworkSmoke = {
        attempts: 0,
        details: [],
        restore: () => {
          window.fetch = originalFetch;
          Object.defineProperty(XMLHttpRequest.prototype, 'open', originalXhrOpen);
        },
      };
      window.fetch = (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (isLocalUrl(url)) return originalFetch(input);
        const smoke = host.__abyssNetworkSmoke;
        if (smoke !== undefined) {
          smoke.attempts += 1;
          smoke.details.push({
            kind: 'fetch',
            stack: new Error().stack ?? '',
            url,
          });
        }
        return Promise.reject(new Error('Network denied by Community package smoke.'));
      };
      XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
        if (isLocalUrl(String(url))) {
          Reflect.apply(callOriginalXhrOpen, this, [method, url]);
          return;
        }
        const smoke = host.__abyssNetworkSmoke;
        if (smoke !== undefined) {
          smoke.attempts += 1;
          smoke.details.push({
            kind: 'xhr',
            stack: new Error().stack ?? '',
            url: String(url),
          });
        }
        throw new Error('Network denied by Community package smoke.');
      };
    });
  });

  after(async () => {
    await browser.execute(() => {
      const host = window as Window & {
        __abyssNetworkSmoke?: {
          attempts: number;
          details: Array<{ kind: string; stack: string; url: string }>;
          restore: () => void;
        };
      };
      const smoke = host.__abyssNetworkSmoke;
      if (smoke !== undefined) {
        smoke.restore();
        delete host.__abyssNetworkSmoke;
      }
    });
  });

  it('contains only release files and opens a real PDF without repository resolution or network', async () => {
    expect(readdirSync(pluginDirectory).sort((left, right) => left.localeCompare(right))).toEqual([
      'main.js',
      'manifest.json',
      'styles.css',
    ]);
    expect(pluginDirectory).not.toContain('node_modules');

    const loadedVersion = await browser.executeObsidian(
      ({ app }, id) => app.plugins.manifests[id]?.version,
      manifest.id,
    );
    expect(loadedVersion).toBe(manifest.version);
    await browser.executeObsidian(async ({ app }) => {
      await app.workspace.openLinkText('Documents/text-12-pages.pdf', '', false);
    });
    await $('[data-abyss-document]').waitForDisplayed();
    await expect($('[data-page-number="1"] canvas')).toExist();

    const runtime = await metrics();
    expect(runtime.versions).toEqual({ pdfjs: '6.2.108', plugin: manifest.version });
    expect(runtime.counters.pdfRuntimeLoads).toBe(1);
    expect(runtime.counters.workerUrlsActive).toBe(1);
    const network = await browser.execute(() => {
      const host = window as Window & {
        __abyssNetworkSmoke?: {
          readonly attempts: number;
          readonly details: ReadonlyArray<{ kind: string; stack: string; url: string }>;
        };
      };
      return host.__abyssNetworkSmoke ?? { attempts: -1, details: [] };
    });
    if (network.attempts !== 0) {
      throw new Error(
        `Packaged reader attempted network access: ${JSON.stringify(network.details)}`,
      );
    }
  });

  it('revokes the packaged worker during plugin disable', async () => {
    await browser.getObsidianPage().disablePlugin(manifest.id);

    expect((await metrics()).counters.workerUrlsActive).toBe(0);
    await expect($('[data-abyss-document]')).not.toExist();
  });
});
