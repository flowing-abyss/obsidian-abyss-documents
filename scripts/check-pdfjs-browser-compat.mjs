/* eslint-disable sonarjs/code-eval -- This test evaluates only locally bundled, pinned PDF.js in isolated realms. */
import { build, transform } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createReadonlyAnnotationFixture } from '../tests/fixtures/pdf-fixtures.mts';
import { createPdfjsCorePlugin } from './pdfjs-core-plugin.mjs';
import { createPdfjsViewerPlugin } from './pdfjs-viewer-plugin.mjs';
import { createPdfjsWorkerPlugin } from './pdfjs-worker-plugin.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const chrome120Features = `
  delete Map.prototype.getOrInsertComputed;
  delete Map.prototype.getOrInsert;
  delete WeakMap.prototype.getOrInsertComputed;
  delete WeakMap.prototype.getOrInsert;
  delete Uint8Array.prototype.toBase64;
  delete Promise.try;
`;

async function loadPackagedRuntime() {
  const output = await build({
    stdin: {
      contents: `
        import { PdfRuntimeLoader } from './src/adapters/pdf/pdf-runtime.ts';
        globalThis.loadPackagedPdfRuntime = () => new PdfRuntimeLoader().load();
      `,
      resolveDir: projectRoot,
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2021',
    write: false,
    plugins: [createPdfjsCorePlugin(), createPdfjsViewerPlugin(), createPdfjsWorkerPlugin()],
  });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const realm = dom.window;
  Object.assign(realm, {
    Response,
    Request,
    Headers,
    TextEncoder,
    TextDecoder,
    structuredClone,
  });
  let workerBlob;
  realm.URL.createObjectURL = (blob) => {
    workerBlob = blob;
    return 'blob:packaged-pdf-worker';
  };
  realm.eval(chrome120Features);
  realm.eval(output.outputFiles[0].text);
  try {
    const runtime = await realm.loadPackagedPdfRuntime();
    const workerSource = await new Promise((resolve, reject) => {
      const reader = new realm.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(workerBlob);
    });
    return { dom, runtime, workerSource };
  } catch (error) {
    realm.close();
    throw error;
  }
}

async function extractWorkerText(workerSource) {
  const { code } = await transform(workerSource, { format: 'iife', target: 'es2021' });
  const messages = [];
  const context = createContext({
    console,
    URL,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    Blob,
    setTimeout,
    clearTimeout,
    AbortController,
    structuredClone,
    postMessage(message) {
      // postMessage snapshots data before PDF.js clears its reusable chunk arrays.
      messages.push(structuredClone(message));
      if (message.action !== 'FetchBinaryData') return;
      assert.equal(message.data.kind, 'standardFontDataUrl');
      const filename = message.data.filename;
      assert.equal(path.basename(filename), filename);
      const font = readFileSync(
        new URL(`../node_modules/pdfjs-dist/standard_fonts/${filename}`, import.meta.url),
      );
      queueMicrotask(() =>
        receive({
          sourceName: message.targetName,
          targetName: message.sourceName,
          callback: 1,
          callbackId: message.callbackId,
          data: font,
        }),
      );
    },
  });
  async function waitForMessage(predicate) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const message = messages.find(predicate);
      if (message !== undefined) return message;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('PDF.js worker did not complete its request.');
  }
  function receive(message) {
    context.incomingMessage = message;
    runInContext('receive(incomingMessage); delete globalThis.incomingMessage;', context);
  }
  runInContext(chrome120Features, context);
  runInContext(code, context);
  runInContext(
    `
    const listeners = [];
    const port = {
      addEventListener(_type, listener) { listeners.push(listener); },
      removeEventListener() {},
      postMessage: globalThis.postMessage,
    };
    globalThis.receive = data => {
      for (const listener of [...listeners]) listener({ data });
    };
    pdfjsWorker.WorkerMessageHandler.initializeFromPort(port);
  `,
    context,
  );
  context.fixtureBytes = Array.from(await createReadonlyAnnotationFixture(false));
  runInContext(
    `receive({ targetName: 'worker', sourceName: 'main', action: 'GetDocRequest',
    callbackId: 1, data: { docId: 'd0', apiVersion: '6.4.299',
      data: Uint8Array.from(fixtureBytes), disableAutoFetch: true,
      evaluatorOptions: { isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false, ignoreErrors: true } } });`,
    context,
  );
  const documentCallback = await waitForMessage(
    (m) => m.callbackId === 1 && m.sourceName === 'worker',
  );
  assert.equal(documentCallback.callback, 1, documentCallback.reason?.message);
  receive({ targetName: 'd0_worker', sourceName: 'd0', action: 'Ready' });
  const documentMessage = await waitForMessage((m) =>
    ['GetDoc', 'DocException'].includes(m.action),
  );
  assert.equal(documentMessage.action, 'GetDoc', documentMessage.data?.message);
  assert.equal(documentMessage.data.pdfInfo.numPages, 1);
  receive({
    targetName: 'd0_worker',
    sourceName: 'd0',
    action: 'GetTextContent',
    streamId: 1,
    desiredSize: 100,
    data: { pageId: 0, pageIndex: 0, includeMarkedContent: false, disableNormalization: false },
  });
  const streamMessage = await waitForMessage((m) => m.streamId === 1 && [3, 5].includes(m.stream));
  assert.equal(streamMessage.stream, 3, streamMessage.reason?.message);
  return messages
    .filter((m) => m.streamId === 1 && m.stream === 4)
    .flatMap((m) => m.chunk.items)
    .map((item) => item.str ?? '')
    .join(' ');
}

async function verifyBrowserCompatibility() {
  const { dom, runtime, workerSource } = await loadPackagedRuntime();
  try {
    const { EventBus, PDFLinkService, PDFFindController } = runtime.pdfjsViewer;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    new PDFFindController({ eventBus, linkService });
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    eventBus.on('pagesinit', listener);
    eventBus.dispatch('pagesinit', {});
    eventBus.off('pagesinit', listener);
    eventBus.dispatch('pagesinit', {});
    assert.equal(calls, 1);
    assert.match(await extractWorkerText(workerSource), /Native annotation qualification/u);
  } finally {
    dom.window.close();
  }
}

await verifyBrowserCompatibility();
console.log(
  'Packaged PDF.js viewer and worker text extraction passed in the Chromium 120 feature realm.',
);

/* eslint-enable sonarjs/code-eval -- End of the isolated compatibility probe. */
