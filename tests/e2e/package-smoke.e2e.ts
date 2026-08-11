import { $, browser, expect } from '@wdio/globals';
import { after, before, describe, it } from 'mocha';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import type { CDPSession, Browser as PuppeteerBrowser } from 'puppeteer-core';

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

interface NetworkSmoke {
  attempts: number;
  details: Array<{ kind: string; stack: string; url: string }>;
  reset: () => void;
  restore: () => void;
}

type SmokeWindow = Window & {
  __abyssNetworkSmoke?: NetworkSmoke;
};

let cdpSession: CDPSession | undefined;
const transportAttempts: string[] = [];

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
    const initiallyEnabled = await browser.executeObsidian(
      ({ app }, pluginId) => app.plugins.enabledPlugins.has(pluginId),
      manifest.id,
    );
    if (initiallyEnabled) throw new Error('Community smoke package must start disabled.');

    const puppeteer = await (
      browser as unknown as { getPuppeteer(): Promise<PuppeteerBrowser> }
    ).getPuppeteer();
    const pages = await puppeteer.pages();
    const page = pages[pages.length - 1];
    if (page === undefined) throw new Error('CDP could not find the Obsidian renderer page.');
    cdpSession = await page.createCDPSession();
    await cdpSession.send('Network.enable');
    cdpSession.on('Network.requestWillBeSent', ({ request }) => {
      const protocol = new URL(request.url).protocol;
      if (!['app:', 'blob:', 'data:', 'file:'].includes(protocol)) {
        transportAttempts.push(request.url);
      }
    });
    await cdpSession.send('Network.setBlockedURLs', {
      urls: ['http', 'https', 'ws', 'wss', 'ftp'].map((protocol) => `${protocol}://*`),
    });

    await browser.execute(() => {
      const host = window as SmokeWindow;
      const originalFetch = window.fetch.bind(window);
      const originalXhrOpen = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'open');
      if (originalXhrOpen === undefined) throw new Error('XMLHttpRequest.open is unavailable.');
      const originalXhrOpenValue: unknown = originalXhrOpen.value;
      if (typeof originalXhrOpenValue !== 'function') {
        throw new Error('XMLHttpRequest.open is not callable.');
      }
      const originalWebSocket = window.WebSocket;
      const originalEventSource = window.EventSource;
      const originalSendBeacon = navigator.sendBeacon.bind(navigator);
      const isLocalUrl = (value: string): boolean => {
        const protocol = new URL(value, window.location.href).protocol;
        return ['app:', 'blob:', 'data:', 'file:'].includes(protocol);
      };
      const smoke: NetworkSmoke = {
        attempts: 0,
        details: [],
        reset: () => {
          smoke.attempts = 0;
          smoke.details.length = 0;
        },
        restore: () => {
          window.fetch = originalFetch;
          Object.defineProperty(XMLHttpRequest.prototype, 'open', originalXhrOpen);
          window.WebSocket = originalWebSocket;
          window.EventSource = originalEventSource;
          navigator.sendBeacon = originalSendBeacon;
        },
      };
      host.__abyssNetworkSmoke = smoke;
      const block = (kind: string, value: string): boolean => {
        if (isLocalUrl(value)) return false;
        smoke.attempts += 1;
        smoke.details.push({ kind, stack: new Error().stack ?? '', url: value });
        return true;
      };

      window.fetch = (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!block('fetch', url)) return originalFetch(input);
        return Promise.reject(new Error('Network denied by Community package smoke.'));
      };
      const smokeXhrOpen = function (this: XMLHttpRequest, ...arguments_: unknown[]) {
        const url = String(arguments_[1]);
        if (!block('xhr', url)) {
          Reflect.apply(originalXhrOpenValue, this, arguments_);
          return;
        }
        throw new Error('Network denied by Community package smoke.');
      };
      Object.defineProperty(XMLHttpRequest.prototype, 'open', {
        ...originalXhrOpen,
        value: smokeXhrOpen,
      });
      window.WebSocket = new Proxy(originalWebSocket, {
        construct(target, arguments_, newTarget) {
          const url = String(arguments_[0]);
          if (block('websocket', url)) {
            throw new Error('Network denied by Community package smoke.');
          }
          return Reflect.construct(target, arguments_, newTarget) as WebSocket;
        },
      });
      window.EventSource = new Proxy(originalEventSource, {
        construct(target, arguments_, newTarget) {
          const url = String(arguments_[0]);
          if (block('event-source', url)) {
            throw new Error('Network denied by Community package smoke.');
          }
          return Reflect.construct(target, arguments_, newTarget) as EventSource;
        },
      });
      navigator.sendBeacon = (url, data) =>
        block('send-beacon', String(url)) ? false : originalSendBeacon(url, data);
    });

    await browser.executeObsidian(async () => {
      const attempts: Array<Promise<unknown>> = [window.fetch('https://abyss.invalid/fetch')];
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://abyss.invalid/xhr');
      } catch {
        // The isolation hook deliberately rejects the probe.
      }
      try {
        new WebSocket('wss://abyss.invalid/socket');
      } catch {
        // The isolation hook deliberately rejects the probe.
      }
      try {
        new EventSource('https://abyss.invalid/events');
      } catch {
        // The isolation hook deliberately rejects the probe.
      }
      navigator.sendBeacon('https://abyss.invalid/beacon', 'probe');
      const image = createEl('img');
      image.src = 'https://abyss.invalid/resource.png';
      document.body.append(image);
      await Promise.allSettled(attempts);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      image.remove();
    });
    const probe = await browser.execute(() => {
      const smoke = (window as SmokeWindow).__abyssNetworkSmoke;
      if (smoke === undefined) throw new Error('Network isolation probe is unavailable.');
      const details = [...smoke.details];
      smoke.reset();
      return details;
    });
    const kinds = probe.map(({ kind }) => kind);
    for (const kind of ['event-source', 'fetch', 'send-beacon', 'websocket', 'xhr']) {
      if (!kinds.includes(kind)) {
        throw new Error(`Network isolation did not exercise ${kind}: ${JSON.stringify(probe)}`);
      }
    }
    if (!transportAttempts.includes('https://abyss.invalid/resource.png')) {
      throw new Error(
        `CDP transport isolation did not record the browser resource probe: ${JSON.stringify(transportAttempts)}`,
      );
    }
    transportAttempts.length = 0;

    await browser.getObsidianPage().enablePlugin(manifest.id);
  });

  after(async () => {
    await browser.execute(() => {
      const host = window as SmokeWindow;
      const smoke = host.__abyssNetworkSmoke;
      if (smoke !== undefined) {
        smoke.restore();
        delete host.__abyssNetworkSmoke;
      }
    });
    const session = cdpSession;
    cdpSession = undefined;
    await session?.detach();
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
    if (transportAttempts.length !== 0) {
      throw new Error(
        `Packaged reader attempted transport-level network access: ${JSON.stringify(transportAttempts)}`,
      );
    }
  });

  it('revokes the packaged worker during plugin disable', async () => {
    await browser.getObsidianPage().disablePlugin(manifest.id);

    expect((await metrics()).counters.workerUrlsActive).toBe(0);
    await expect($('[data-abyss-document]')).not.toExist();
    const attempts = await browser.execute(
      () => (window as SmokeWindow).__abyssNetworkSmoke?.details ?? [],
    );
    if (attempts.length !== 0 || transportAttempts.length !== 0) {
      throw new Error(
        `Packaged reader attempted network access during disable: ${JSON.stringify({ attempts, transportAttempts })}`,
      );
    }
  });
});
