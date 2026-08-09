# PDF Reader Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-quality, Obsidian-native PDF reading view with a PDF-only initial surface, virtualized rendering, page navigation, document outline, document-only search, reading profiles, responsive behavior, and real-vault performance/visual verification.

**Architecture:** The UI depends only on owned Document Core contracts. A PDF adapter contains every PDF.js type and creates a core `DocumentViewport`; Obsidian integration owns view registration, commands, settings, and lifecycle. PDF.js 6.2.108 and its matching worker are packaged self-contained, but loaded and instantiated only when a PDF view becomes visible.

**Tech Stack:** TypeScript 5.9, Obsidian API 1.13.1, PDF.js 6.2.108, fflate 0.8.3, esbuild 0.28.1, Vitest 4, WebdriverIO 9, Appium 3, Obsidian CLI 1.12+, PostCSS 8.5.26.

## Scope boundary

This is plan 1 of 3 for the approved design. It ends with a useful read-only PDF product and the infrastructure later plans consume.

1. This plan: PDF reader foundation.
2. Follow-on plan: portable annotation writes, crash journal, comments, links/tags, drag export, and derived annotation index.
3. Follow-on plan: local OCR provider, language assets, progress/resume, and safe searchable-copy/in-place commit paths.

Annotation rendering from existing PDFs is allowed in this plan, but new annotation creation, PDF mutation, semantic indexing, EPUB/FB2, and OCR controls do not appear until their capabilities are implemented and separately reviewed.

## Global Constraints

- `manifest.json.id` becomes `abyss-documents` before the first release and is never renamed afterward.
- Initial supported platforms are macOS, Windows, Linux, and Android; platform checks must not architecturally exclude iOS/iPadOS.
- A newly opened document view shows only the PDF reading surface and compact toolbar; the sidebar is hidden until an explicit action.
- `Ctrl/Cmd+F` searches only the PDF text layer. Annotation search is a separate later capability.
- All user-facing copy is concise sentence-case English.
- Use Obsidian `setIcon`, CSS variables, focus conventions, `Notice`, `Setting`, and registered cleanup APIs; no hard-coded visual theme or leaked listeners.
- No network call, remote code, telemetry, or external service is introduced by this plan.
- PDF.js and OCR work must not run during ordinary plugin activation. The matching PDF.js worker is created only when the first PDF session opens and is revoked on unload.
- Only `main.js`, `manifest.json`, and `styles.css` can be assumed to arrive through the Community installer, so the worker payload must be self-contained.
- The full repository gate is `pnpm run verify`; `pnpm run verify:task` is only a mid-task check.
- `dev-documents-vault/`, screenshot artifacts, and generated performance output remain ignored by Git.
- Production rules are scoped under `.abyss-documents`; PDF.js CSS is prefixed at build time so it cannot alter Obsidian's core PDF view or other plugins.

## File map

### Plugin and persisted state

- `src/main.ts` — plugin composition root and registrations only.
- `src/plugin-data.ts` — versioned persisted data, serialization queue, and update API.
- `src/settings.ts` — settings/view-state types and defaults.
- `src/settings-tab.ts` — native collapsible settings sections.

### Owned Document Core

- `src/document-core/document.ts` — document metadata, outline, search, viewport, and capability types.
- `src/document-core/reading.ts` — shared reading-profile identifiers and resolved colors.
- `src/document-core/document-adapter.ts` — adapter registry and open request contracts.
- `src/document-core/events.ts` — typed viewport events and unsubscribe contract.
- `src/document-core/errors.ts` — typed safe-to-present failures.

### PDF adapter

- `src/adapters/pdf/pdf-runtime.ts` — single-flight lazy PDF.js/worker loader and cleanup.
- `src/adapters/pdf/pdf-worker-payload.d.ts` — type declaration for the generated compressed worker module.
- `src/adapters/pdf/pdf-adapter.ts` — file support and session creation.
- `src/adapters/pdf/pdf-session.ts` — outline, text/search, metadata, close, and viewport factory.
- `src/adapters/pdf/pdf-text-search.ts` — cancellable public-API text extraction and snippets.
- `src/adapters/pdf/pdf-viewport.ts` — PDFViewer/EventBus/PDFFindController integration hidden behind `DocumentViewport`.
- `src/adapters/pdf/pdf-mappers.ts` — conversion of PDF.js outline/search/page values to core types.

### Reader application and UI

- `src/reader/reader-controller.ts` — open/close, user intents, and observable reader state.
- `src/reader/document-view.ts` — Obsidian `FileView` lifecycle.
- `src/reader/reader-shell.ts` — minimal DOM ownership and region composition.
- `src/reader/toolbar.ts` — sidebar toggle, page field, current mode, reading profile, overflow.
- `src/reader/sidebar.ts` — hidden-by-default Outline/Search shell.
- `src/reader/outline-panel.ts` — outline tree and navigation.
- `src/reader/search-panel.ts` — document-only find UI and result navigation.
- `src/reader/reading-profiles.ts` — Auto/Light/Sepia/Dark/Custom resolution.
- `src/reader/a11y.ts` — focus return and polite live-region helpers.

### Build, styles, tests, and development vault

- `esbuild.config.mjs` — compressed raw worker plugin, bundle budget, and style build hook.
- `scripts/build-styles.mjs` — prefix PDF.js CSS and append plugin source CSS.
- `scripts/generate-dev-vault.mts` — deterministic PDF fixtures and dev vault configuration.
- `scripts/smoke-community-package.mts` — three-file offline Community-package qualification.
- `scripts/benchmark-reader.mts` — repeatable cold/warm activation and first-page measurements.
- `src/styles/reader.css` — Obsidian-native layout and responsive rules.
- `src/styles/settings.css` — settings sections and cards.
- `styles.css` — generated release stylesheet.
- `tests/e2e/reader.e2e.ts` — real-Obsidian reader behavior.
- `tests/e2e/reader.mobile.e2e.ts` — Android/mobile behavior.
- `tests/fixtures/pdf-fixtures.mts` — deterministic small and 700-page PDFs.
- `artifacts/manual-qa/` — ignored screenshots and inspection output.

## Shared interfaces

Every task uses these exact core contracts; PDF.js-specific values stay inside `src/adapters/pdf/`.

```ts
import type { ReadingProfileId, ResolvedReadingColors } from './reading.js';

export type DocumentCapability =
  'outline' | 'text-search' | 'existing-annotations' | 'annotation-write' | 'ocr';

export interface DocumentDescriptor {
  readonly path: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly pageCount: number;
}

export interface OutlineItem {
  readonly id: string;
  readonly label: string;
  readonly target: DocumentLocation | null;
  readonly children: readonly OutlineItem[];
}

export interface DocumentLocation {
  readonly pageIndex: number;
  readonly x?: number;
  readonly y?: number;
}

export interface SearchHit {
  readonly id: string;
  readonly pageIndex: number;
  readonly matchIndex: number;
  readonly preview: string;
}

export interface SearchResultSet {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly complete: boolean;
}

export type ViewportEvent =
  | { readonly type: 'page-change'; readonly pageIndex: number }
  | { readonly type: 'scale-change'; readonly scale: number | 'page-width' | 'page-fit' }
  | { readonly type: 'search-results'; readonly results: SearchResultSet }
  | { readonly type: 'render-error'; readonly pageIndex: number; readonly cause: unknown };

export interface DocumentViewport {
  readonly pageCount: number;
  mount(host: HTMLElement): Promise<void>;
  goTo(location: DocumentLocation): Promise<void>;
  setScale(scale: number | 'page-width' | 'page-fit'): void;
  setReadingColors(colors: ResolvedReadingColors): void;
  search(query: string): void;
  searchAgain(direction: 'next' | 'previous'): void;
  selectSearchHit(hit: SearchHit, query: string): Promise<void>;
  onEvent(listener: (event: ViewportEvent) => void): () => void;
  focus(): void;
  destroy(): Promise<void>;
}

export interface DocumentSession {
  readonly descriptor: DocumentDescriptor;
  readonly capabilities: ReadonlySet<DocumentCapability>;
  getOutline(): Promise<readonly OutlineItem[]>;
  createViewport(): Promise<DocumentViewport>;
  close(): Promise<void>;
}

export interface DocumentAdapter {
  readonly id: string;
  supports(file: TFile): boolean;
  open(file: TFile, signal: AbortSignal): Promise<DocumentSession>;
}
```

## Risk Scan

- **Community packaging:** extra worker chunks are not installed. Check: production `main.js` alone opens a PDF after temporarily hiding `node_modules` and denying network access.
- **Startup performance:** self-contained PDF payload increases file size. Check: activation benchmark proves no gzip decode, Blob creation, Worker construction, or PDF import before a PDF view opens; p95 plugin activation remains below 100 ms on the named desktop reference device.
- **Library compatibility:** PDF.js library and worker mismatch causes runtime failure. Check: unit/build test asserts both exported versions equal `6.2.108`, plus real-vault open.
- **Vault/mobile boundary:** binary reads differ between filesystem and Capacitor adapters. Check: use only `Vault.readBinary(TFile)` in foundation code and run Android e2e.
- **File takeover:** registering `.pdf` must not strand leaves or break unload/reload. Check: real-Obsidian tests open PDF, reload/disable plugin, reopen, and assert one live view without console errors.
- **Long documents:** eager DOM/page rendering causes memory and scroll failures. Check: 700-page e2e asserts bounded rendered canvas/text-layer counts during first page, middle, and final-page navigation.
- **Keyboard conflict:** Find must never search annotations. Check: e2e presses `Ctrl/Cmd+F`, asserts Search tab and document result, and asserts no annotation-search element is active.
- **Visual isolation:** imported PDF.js CSS could leak into Obsidian. Check: CSS build prefixes selectors and DOM/CSS inspection confirms core workspace nodes are unaffected.

---

### Task 1: Establish plugin identity and versioned state

**Files:**

- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `src/main.ts`
- Modify: `src/settings.ts`
- Create: `src/document-core/reading.ts`
- Create: `src/plugin-data.ts`
- Modify: `src/main.test.ts`
- Modify: `src/settings.test.ts`
- Create: `src/plugin-data.test.ts`

**Interfaces:**

- Produces: `PLUGIN_ID`, `ReadingProfileId`, `ResolvedReadingColors`, `PluginDataV1`, `PluginDataStore.load()`, `PluginDataStore.update(mutator)`, `AbyssDocumentsPlugin.data`.
- Consumes: Obsidian `Plugin.loadData()` and `Plugin.saveData()`.

**Project-specific requirements:**

- Use `this.register*` for cleanup and keep `onload()` limited to registrations/data load.
- Set `manifest.json` to `id: "abyss-documents"`, `name: "Abyss Documents"`, `minAppVersion: "1.7.2"`, and `isDesktopOnly: false`.

**Required sources:**

- [Obsidian manifest reference](https://docs.obsidian.md/Reference/Manifest) — ID constraints, mobile flag, and immutable release identity.
- [Optimize plugin load time](https://docs.obsidian.md/Plugins/Guides/Optimizing%20plugin%20load%20time) — keep expensive work outside `onload()`.

- [ ] **Step 1: Write failing state and identity tests**

```ts
it('loads version 1 data with a PDF-only view default', async () => {
  const plugin = createPlugin();
  await plugin.onload();
  expect(plugin.data.settings.reading.defaultProfile).toBe('auto');
  expect(plugin.data.view.sidebar.open).toBe(false);
});

it('serializes concurrent updates through one save queue', async () => {
  const store = createStore();
  await Promise.all([
    store.update((data) => ({ ...data, view: { ...data.view, selectedTab: 'outline' } })),
    store.update((data) => ({ ...data, view: { ...data.view, sidebarWidth: 340 } })),
  ]);
  expect(store.snapshot.view).toMatchObject({ selectedTab: 'outline', sidebarWidth: 340 });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm vitest run src/main.test.ts src/settings.test.ts src/plugin-data.test.ts`

Expected: FAIL because `PluginDataStore`, `plugin.data`, and the new settings shape do not exist.

- [ ] **Step 3: Implement the versioned root data and minimal composition root**

```ts
export interface PluginDataV1 {
  readonly schemaVersion: 1;
  readonly settings: {
    readonly reading: {
      readonly defaultProfile: ReadingProfileId;
      readonly rememberPerDocument: boolean;
      readonly custom: ResolvedReadingColors;
    };
    readonly debugLogging: boolean;
  };
  readonly view: {
    readonly sidebar: { readonly open: false };
    readonly selectedTab: 'outline' | 'search';
    readonly sidebarWidth: number;
    readonly profileByFingerprint: Readonly<Record<string, ReadingProfileId>>;
  };
}

// src/document-core/reading.ts
export type ReadingProfileId = 'auto' | 'light' | 'sepia' | 'dark' | 'custom';
export interface ResolvedReadingColors {
  readonly background: string;
  readonly foreground: string;
  readonly brightness: number;
  readonly contrast: number;
  readonly imageDim: number;
}

export const DEFAULT_DATA: PluginDataV1 = {
  schemaVersion: 1,
  settings: {
    reading: {
      defaultProfile: 'auto',
      rememberPerDocument: false,
      custom: {
        background: '#202020',
        foreground: '#dddddd',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    },
    debugLogging: false,
  },
  view: {
    sidebar: { open: false },
    selectedTab: 'outline',
    sidebarWidth: 320,
    profileByFingerprint: {},
  },
};
```

`PluginDataStore.update` appends the entire read-mutate-save operation to a private `Promise<void>` queue. Each queued mutator receives the latest committed snapshot (not the snapshot that existed when `update` was called), and the in-memory snapshot advances only after `saveData` succeeds. A rejected save leaves the previous snapshot intact and does not poison later queue entries. Rename the plugin class to `AbyssDocumentsPlugin`; do not register a view yet.

- [ ] **Step 4: Run focused tests and the task gate**

Run: `pnpm vitest run src/main.test.ts src/settings.test.ts src/plugin-data.test.ts && pnpm run verify:task`

Expected: PASS with the immutable version-1 defaults and serialized concurrent updates.

- [ ] **Step 5: Commit**

```bash
git add manifest.json package.json src/main.ts src/settings.ts src/plugin-data.ts src/document-core/reading.ts src/main.test.ts src/settings.test.ts src/plugin-data.test.ts
git commit -m "feat: establish Abyss Documents plugin state"
```

### Task 2: Define and test the owned Document Core

**Files:**

- Create: `src/document-core/document.ts`
- Create: `src/document-core/document-adapter.ts`
- Create: `src/document-core/events.ts`
- Create: `src/document-core/errors.ts`
- Create: `src/document-core/document-adapter.test.ts`
- Create: `src/document-core/events.test.ts`

**Interfaces:**

- Produces: every contract in `## Shared interfaces`, `DocumentAdapterRegistry`, `TypedEventSource<T>`, `DocumentOpenError`, `DocumentCancelledError`, `DocumentPasswordError`, and `InvalidDocumentError`.
- Consumes: `TFile` as an opaque Obsidian file handle at the adapter boundary only.

- [ ] **Step 1: Write failing registry and event cleanup tests**

```ts
it('selects exactly one adapter by registration order', () => {
  const registry = new DocumentAdapterRegistry([unsupported, pdf]);
  expect(registry.requireFor(pdfFile)).toBe(pdf);
});

it('unsubscribe prevents later viewport delivery', () => {
  const events = new TypedEventSource<ViewportEvent>();
  const listener = vi.fn();
  const unsubscribe = events.subscribe(listener);
  unsubscribe();
  events.emit({ type: 'page-change', pageIndex: 4 });
  expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm vitest run src/document-core/document-adapter.test.ts src/document-core/events.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the exact shared interfaces and small utilities**

```ts
export class DocumentAdapterRegistry {
  constructor(private readonly adapters: readonly DocumentAdapter[]) {}

  requireFor(file: TFile): DocumentAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(file));
    if (!adapter) throw new DocumentOpenError(file.path, 'No reader supports this file.');
    return adapter;
  }
}

export class TypedEventSource<T> {
  private readonly listeners = new Set<(event: T) => void>();
  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: T): void {
    for (const listener of this.listeners) listener(event);
  }
  clear(): void {
    this.listeners.clear();
  }
}
```

Keep files focused; no PDF.js imports are allowed under `src/document-core/`.

- [ ] **Step 4: Run tests and architecture gate**

Run: `pnpm vitest run src/document-core && pnpm arch`

Expected: PASS and no dependency from Document Core to adapters/UI.

- [ ] **Step 5: Commit**

```bash
git add src/document-core
git commit -m "feat: define document core contracts"
```

### Task 3: Package and lazy-load the self-contained PDF.js runtime

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `esbuild.config.mjs`
- Modify: `src/main.ts`
- Modify: `src/main.test.ts`
- Create: `src/adapters/pdf/pdf-worker-payload.d.ts`
- Create: `src/adapters/pdf/pdf-runtime.ts`
- Create: `src/adapters/pdf/pdf-runtime.test.ts`
- Create: `scripts/build-styles.mjs`
- Create: `src/styles/reader.css`
- Modify: `styles.css`
- Modify: `stylelint.config.mjs`

**Interfaces:**

- Produces: `PdfRuntimeLoader.load(): Promise<PdfRuntime>`, `PdfRuntimeLoader.dispose(): void`.
- `PdfRuntime` exposes `pdfjsLib`, `pdfjsViewer`, and matching `version` only inside `src/adapters/pdf/`.
- Consumes: `pdfjs-dist@6.2.108`, `fflate@0.8.3`, `postcss@8.5.26`, `postcss-prefix-selector@2.1.1`.
- The composition root owns one `PdfRuntimeLoader` so the runtime is packaged, but plugin activation does not call `load()`; Task 5 registers disposal when it wires the PDF view.

**Required sources:**

- [PDF.js setup guide](https://github.com/mozilla/pdf.js/wiki/Setup-PDF.js-in-a-website) — library/worker separation and version matching.
- [PDF.js public API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) — `getDocument`, `GlobalWorkerOptions`, and public display entry point.
- [Obsidian release packaging](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) — installer downloads only `main.js`, `manifest.json`, and optional `styles.css`.

**Risk checks:**

- Community packaging and startup-performance checks from `## Risk Scan`.

- [ ] **Step 1: Write failing single-flight, version, and cleanup tests**

```ts
it('creates one worker URL only on first load and revokes it on dispose', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-worker');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const loader = createRuntimeLoader();
  expect(create).not.toHaveBeenCalled();
  const [left, right] = await Promise.all([loader.load(), loader.load()]);
  expect(left).toBe(right);
  expect(left.version).toBe('6.2.108');
  expect(create).toHaveBeenCalledOnce();
  loader.dispose();
  expect(revoke).toHaveBeenCalledWith('blob:pdf-worker');
});

it('clears a failed single-flight load so Retry can load again', async () => {
  const loader = createRuntimeLoader({ failImports: 1 });
  await expect(loader.load()).rejects.toThrow();
  await expect(loader.load()).resolves.toMatchObject({ version: '6.2.108' });
});

it('revokes a worker URL created after dispose wins an in-flight race', async () => {
  const loader = createDeferredRuntimeLoader();
  const loading = loader.load();
  loader.dispose();
  resolveDeferredImports();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf-worker');
});

it('does not let a stale failed load erase an immediate reload', async () => {
  const loader = createTwoGenerationRuntimeLoader();
  const staleLoad = loader.load();
  loader.dispose();
  const currentLoad = loader.load();
  rejectFirstGenerationImports();
  await expect(staleLoad).rejects.toBeDefined();
  expect(loader.load()).toBe(currentLoad);
  await expect(currentLoad).resolves.toMatchObject({ version: '6.2.108' });
  expect(activeWorkerUrls()).toHaveLength(1);
  loader.dispose();
  expect(activeWorkerUrls()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm vitest run src/adapters/pdf/pdf-runtime.test.ts`

Expected: FAIL because the runtime loader and raw worker module do not exist.

- [ ] **Step 3: Add exact dependencies and the gzip worker build plugin**

Run:

```bash
pnpm add fflate@0.8.3
pnpm add -D postcss@8.5.26 postcss-prefix-selector@2.1.1
```

In `esbuild.config.mjs`, resolve `pdfjs-dist/build/pdf.worker.mjs?gzip-base64`, gzip it with Node `zlib.gzipSync(..., { level: 9 })`, and emit a JS module containing one base64 string. Raise `release.mainJsBudgetBytes` to `2097152`; the build must still fail above 2 MiB.

- [ ] **Step 4: Implement the lazy runtime loader**

```ts
export class PdfRuntimeLoader {
  private loadPromise: Promise<PdfRuntime> | null = null;
  private workerUrl: string | null = null;
  private generation = 0;

  load(): Promise<PdfRuntime> {
    if (this.loadPromise) return this.loadPromise;
    const pending = this.loadOnce();
    let guarded!: Promise<PdfRuntime>;
    guarded = pending.catch((error: unknown) => {
      if (this.loadPromise === guarded) this.loadPromise = null;
      throw error;
    });
    this.loadPromise = guarded;
    return this.loadPromise;
  }

  dispose(): void {
    this.generation += 1;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.loadPromise = null;
  }

  private async loadOnce(): Promise<PdfRuntime> {
    const generation = this.generation;
    const [{ gunzipSync }, workerPayload, pdfjsLib, pdfjsViewer] = await Promise.all([
      import('fflate'),
      import('pdfjs-dist/build/pdf.worker.mjs?gzip-base64'),
      import('pdfjs-dist/build/pdf.mjs'),
      import('pdfjs-dist/web/pdf_viewer.mjs'),
    ]);
    const compressed = Uint8Array.from(atob(workerPayload.default), (character) =>
      character.charCodeAt(0),
    );
    const workerSource = gunzipSync(compressed);
    const workerBytes = workerSource.slice().buffer;
    const workerUrl = URL.createObjectURL(new Blob([workerBytes], { type: 'text/javascript' }));
    try {
      if (generation !== this.generation) throw new DOMException('Disposed', 'AbortError');
      if (pdfjsLib.version !== '6.2.108') throw new Error(`Unexpected PDF.js ${pdfjsLib.version}`);
      this.workerUrl = workerUrl;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return { pdfjsLib, pdfjsViewer, version: pdfjsLib.version };
    } catch (error) {
      URL.revokeObjectURL(workerUrl);
      throw error;
    }
  }
}
```

`dispose()` is idempotent. Task 5 registers it with `plugin.register(() => runtimeLoader.dispose())`; no worker URL may survive plugin unload, a failed import/version check, or an in-flight load/dispose race.

- [ ] **Step 5: Build scoped PDF.js and plugin CSS**

`scripts/build-styles.mjs` reads `node_modules/pdfjs-dist/web/pdf_viewer.css`, prefixes normal selectors with `.abyss-documents` using PostCSS, preserves keyframes/font-face rules, appends `src/styles/reader.css`, and writes the generated root `styles.css` with a generated-file header. Add a unit-level script assertion that no non-at-rule selector begins outside `.abyss-documents`. Make both `build` and the watch-mode rebuild call `build:styles`; `verify` checks that a fresh style build leaves `styles.css` unchanged.

- [ ] **Step 6: Run runtime, build, and size checks**

Run: `pnpm vitest run src/adapters/pdf/pdf-runtime.test.ts && pnpm run build && pnpm run build:analyze`

Expected: PASS; analysis shows PDF runtime in `main.js`, worker source compressed, output at or below 2 MiB, and no runtime loader call from plugin `onload()` tests.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml esbuild.config.mjs scripts/build-styles.mjs src/adapters/pdf src/main.ts src/main.test.ts src/styles/reader.css styles.css stylelint.config.mjs
git commit -m "build: package lazy PDF.js runtime"
```

### Task 4: Implement the read-only PDF adapter and session

**Files:**

- Create: `src/adapters/pdf/pdf-adapter.ts`
- Create: `src/adapters/pdf/pdf-session.ts`
- Create: `src/adapters/pdf/pdf-mappers.ts`
- Create: `src/adapters/pdf/pdf-adapter.test.ts`
- Create: `src/adapters/pdf/pdf-session.test.ts`
- Create: `src/adapters/pdf/pdf-mappers.test.ts`
- Create: `src/adapters/pdf/pdf-text-search.ts`
- Create: `src/adapters/pdf/pdf-text-search.test.ts`

**Interfaces:**

- Produces: `PdfDocumentAdapter`, `PdfDocumentSession`, `PdfTextSearch`, `mapPdfOutline()`.
- Consumes: `PdfRuntimeLoader`, `Vault.readBinary(TFile)`, and Document Core contracts.

**Required sources:**

- [PDFDocumentProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html) — `fingerprints`, `numPages`, `getOutline`, `getPage`, `getPermissions`, `cleanup`, and `destroy` semantics.
- [PDFPageProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html) — page text/annotation access.
- [Obsidian Vault guide](https://docs.obsidian.md/Plugins/Vault) — use Vault APIs instead of filesystem access.

**Failure-handling requirements:**

- Adapter/session methods enrich and rethrow; they never create `Notice` and never swallow a password, invalid-PDF, or cancellation failure.
- Log only path, operation, and error class behind the plugin debug toggle; never log PDF text.

- [ ] **Step 1: Write failing adapter/session tests with a fake PDF runtime**

```ts
it('supports PDF extensions case-insensitively', () => {
  expect(adapter.supports(file('Books/Guide.PDF'))).toBe(true);
  expect(adapter.supports(file('Books/Guide.epub'))).toBe(false);
});

it('maps outline destinations and exposes read-only capabilities', async () => {
  const session = await adapter.open(file('Guide.pdf'), AbortSignal.timeout(1_000));
  expect(session.capabilities).toEqual(new Set(['outline', 'text-search', 'existing-annotations']));
  expect(await session.getOutline()).toEqual([
    { id: 'outline-0', label: 'Chapter 1', target: { pageIndex: 2 }, children: [] },
  ]);
});

it.each([
  ['abort', 'DocumentCancelledError'],
  ['password-required', 'DocumentPasswordError'],
  ['password-incorrect', 'DocumentPasswordError'],
  ['invalid-pdf', 'InvalidDocumentError'],
  ['generic', 'DocumentOpenError'],
])('maps %s without collapsing the typed cause', async (fixture, expectedName) => {
  await expect(openFixture(fixture)).rejects.toMatchObject({ name: expectedName });
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm vitest run src/adapters/pdf/pdf-adapter.test.ts src/adapters/pdf/pdf-session.test.ts src/adapters/pdf/pdf-mappers.test.ts src/adapters/pdf/pdf-text-search.test.ts`

Expected: FAIL with missing adapter/session.

- [ ] **Step 3: Implement binary loading, abort, outline mapping, and close**

```ts
async open(file: TFile, signal: AbortSignal): Promise<DocumentSession> {
  const runtime = await this.runtimeLoader.load();
  signal.throwIfAborted();
  const bytes = await this.vault.readBinary(file);
  signal.throwIfAborted();
  const loadingTask = runtime.pdfjsLib.getDocument({ data: bytes });
  const abort = () => void loadingTask.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await loadingTask.promise;
    return new PdfDocumentSession(file, pdf, runtime.pdfjsViewer);
  } catch (cause) {
    throw mapPdfOpenFailure(file.path, cause, signal);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
```

`mapPdfOpenFailure` maps abort, password-required, password-incorrect, invalid-PDF, and generic load errors to separate owned core errors with safe messages and retry guidance. Map named/explicit outline destinations through `getDestination`/`getPageIndex`; unresolved destinations remain `target: null` instead of rejecting the entire outline.

Implement `PdfTextSearch` only through public `PDFDocumentProxy.getPage()` and `PDFPageProxy.getTextContent()`. It normalizes text items into page strings, produces bounded context snippets and stable page/match IDs, emits partial immutable `SearchResultSet`s while scanning, caches only extracted page text for the live session, and stops promptly when its `AbortSignal` is cancelled. `PdfDocumentSession.createViewport()` creates one session-owned search service and passes it to `PdfDocumentViewport`; session close cancels and clears it. Tests cover cancellation, repeated matches, snippets across text-item boundaries, partial result order, and cache cleanup on session close. `PDFFindController` remains responsible only for visible highlighting and next/previous navigation; no private PDF.js field is read.

- [ ] **Step 4: Run focused tests and task gate**

Run: `pnpm vitest run src/adapters/pdf && pnpm run verify:task`

Expected: PASS, including one test that aborts during loading and one that calls close twice.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/pdf
git commit -m "feat: add read-only PDF document adapter"
```

### Task 5: Create the virtualized viewport and Obsidian FileView

**Files:**

- Create: `src/adapters/pdf/pdf-viewport.ts`
- Create: `src/adapters/pdf/pdf-viewport.test.ts`
- Create: `src/reader/reader-controller.ts`
- Create: `src/reader/reader-controller.test.ts`
- Create: `src/reader/reader-shell.ts`
- Create: `src/reader/reader-shell.test.ts`
- Create: `src/reader/document-view.ts`
- Create: `src/reader/document-view.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Produces: `PdfDocumentViewport`, `ReaderController`, `ReaderShell`, `AbyssDocumentView`, `DOCUMENT_VIEW_TYPE = 'abyss-document-view'`.
- Consumes: `DocumentAdapterRegistry`, `DocumentSession.createViewport()`, `FileView.onLoadFile/onUnloadFile`.

**Required sources:**

- Obsidian 1.13.1 declarations for `Plugin.registerView`, `Plugin.registerExtensions`, and `FileView` — public extension/view lifecycle used by the installed dependency.
- [Deferred views guide](https://docs.obsidian.md/Plugins/Guides/Defer%20views) — do not force hidden workspace leaves to load.
- Installed `pdfjs-dist@6.2.108/types/web/pdf_viewer.d.ts` plus the [PDF.js public API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) — exact-version viewer options, built-in lazy-page behavior, text layer, and annotation layer.

**Risk checks:**

- File takeover, long-document virtualization, and mobile binary boundary checks from `## Risk Scan`.

**Failure-handling requirements:**

- `ReaderController.open` propagates typed failures. `AbyssDocumentView.onLoadFile` is the single boundary that shows `Notice('Could not open <name>: <reason>')`, renders an inline retry action, and logs `[abyss-documents] Failed to open PDF` with path/cause.
- Render failures update one page-local retry surface and log once; no rejection escapes from an event callback.

- [ ] **Step 1: Write failing lifecycle and PDF-only shell tests**

```ts
it('starts with the sidebar absent from layout', async () => {
  const shell = new ReaderShell(document.body);
  expect(shell.root.querySelector('[data-region="document"]')).not.toBeNull();
  expect(shell.root.querySelector('[data-region="sidebar"]')).toBeNull();
});

it('closes the previous session before loading another file', async () => {
  await controller.open(firstPdf);
  await controller.open(secondPdf);
  expect(firstSession.close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run src/reader src/adapters/pdf/pdf-viewport.test.ts`

Expected: FAIL with missing view/controller/shell.

- [ ] **Step 3: Implement `PdfDocumentViewport` through PDF.js viewer components**

Create `EventBus`, `PDFLinkService`, `PDFFindController`, and `PDFViewer` inside the adapter. Configure only options present in the pinned 6.2.108 declarations: `textLayerMode`, `annotationMode`, `enablePermissions: true`, `supportsPinchToZoom: true`, `maxCanvasPixels`, and page colors. Unit tests inject fake viewer constructors because jsdom has no production canvas implementation; real PDF.js integration is qualified in Tasks 9-10. Wire only typed core events outward. `destroy()` detaches EventBus listeners, clears the viewer document, cancels find/render work, and clears the event source.

- [ ] **Step 4: Implement the FileView and register `.pdf`**

```ts
export class AbyssDocumentView extends FileView {
  getViewType(): string {
    return DOCUMENT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.file?.basename ?? 'Document';
  }
  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.controller.open(file, this.contentEl);
  }
  async onUnloadFile(file: TFile): Promise<void> {
    await this.controller.close();
    await super.onUnloadFile(file);
  }
}

this.registerView(DOCUMENT_VIEW_TYPE, (leaf) => new AbyssDocumentView(leaf, services));
this.registerExtensions(['pdf'], DOCUMENT_VIEW_TYPE);
this.register(() => runtimeLoader.dispose());
```

The shell mounts the toolbar and document host immediately; it does not create sidebar DOM until explicitly requested.

- [ ] **Step 5: Run focused tests and verify bounded page DOM in the fake viewer**

Run: `pnpm vitest run src/reader src/adapters/pdf/pdf-viewport.test.ts && pnpm arch`

Expected: PASS; lifecycle cleanup is called exactly once and the shell has no sidebar initially.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/reader src/adapters/pdf/pdf-viewport.ts src/adapters/pdf/pdf-viewport.test.ts
git commit -m "feat: open PDFs in a native document view"
```

### Task 6: Add calm navigation and reading profiles

**Files:**

- Create: `src/reader/toolbar.ts`
- Create: `src/reader/toolbar.test.ts`
- Create: `src/reader/reading-profiles.ts`
- Create: `src/reader/reading-profiles.test.ts`
- Modify: `src/reader/reader-controller.ts`
- Modify: `src/reader/reader-shell.ts`
- Modify: `src/styles/reader.css`

**Interfaces:**

- Produces: `ReaderToolbar`, `ReadingProfileService.resolve(profile, obsidianTheme)`, toolbar intents `{toggleSidebar, goToPage, previousPage, nextPage, setScale, setProfile}`.
- Consumes: `DocumentViewport.goTo`, `setScale`, `setReadingColors`, viewport page/scale events.

**Required sources:**

- [Obsidian HTML elements](https://docs.obsidian.md/Plugins/User%20interface/HTML%20elements) and installed `setIcon` API — native DOM/icon construction.
- PDF.js 6.2.108 `PDFViewerOptions.pageColors` declaration — foreground/background rendering support and its limitations.

- [ ] **Step 1: Write failing page-field and profile tests**

```ts
it('clamps an entered page and navigates on Enter', () => {
  toolbar.setPageCount(702);
  pageInput.value = '900';
  pageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(onIntent).toHaveBeenCalledWith({ type: 'go-to-page', pageIndex: 701 });
});

it('Auto follows Obsidian without mutating stored profile', () => {
  expect(service.resolve('auto', 'dark')).toEqual(BUILTIN_PROFILES.dark);
  expect(service.resolve('auto', 'light')).toEqual(BUILTIN_PROFILES.light);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run src/reader/toolbar.test.ts src/reader/reading-profiles.test.ts`

Expected: FAIL with missing toolbar/profile service.

- [ ] **Step 3: Implement icon-first toolbar and profile menu**

Always visible: sidebar toggle, previous/page-field/total/next, current Selection mode, desktop profile button, overflow. Use `setIcon` with `panel-left`, `chevron-left`, `chevron-right`, `mouse-pointer-2`, `sun-moon`, and `more-horizontal`; labels are tooltips/ARIA, not visible words. Put fit width/page and numeric zoom in overflow. On mobile, profile moves to overflow.

Apply `auto`, `light`, `sepia`, `dark`, and `custom` through `setReadingColors`; foreground/background use PDF.js page colors, while bounded CSS variables apply brightness, contrast, and image dimming to the owned page surface. Do not invert images or alter PDF bytes. Theme changes update Auto via Obsidian's registered CSS/theme change event or a scoped `MutationObserver` registered for cleanup.

When `rememberPerDocument` is enabled, profile changes update `view.profileByFingerprint[session.descriptor.fingerprint]`; a newly opened session restores that profile after its fingerprint is known. When disabled, the controller uses the global default and does not mutate the map. Add controller tests for restore, update, disabled behavior, and unknown fingerprints.

- [ ] **Step 4: Run tests and accessibility assertions**

Run: `pnpm vitest run src/reader/toolbar.test.ts src/reader/reading-profiles.test.ts src/reader/reader-shell.test.ts`

Expected: PASS; every icon button has `aria-label`, active tools have `aria-pressed`, and invalid page input restores the current page.

- [ ] **Step 5: Commit**

```bash
git add src/reader/toolbar.ts src/reader/toolbar.test.ts src/reader/reading-profiles.ts src/reader/reading-profiles.test.ts src/reader/reader-controller.ts src/reader/reader-shell.ts src/styles/reader.css
git commit -m "feat: add PDF navigation and reading profiles"
```

### Task 7: Add the opt-in outline and document-only search sidebar

**Files:**

- Create: `src/reader/sidebar.ts`
- Create: `src/reader/sidebar.test.ts`
- Create: `src/reader/outline-panel.ts`
- Create: `src/reader/outline-panel.test.ts`
- Create: `src/reader/search-panel.ts`
- Create: `src/reader/search-panel.test.ts`
- Modify: `src/reader/reader-controller.ts`
- Modify: `src/reader/reader-shell.ts`
- Modify: `src/main.ts`
- Modify: `src/styles/reader.css`

**Interfaces:**

- Produces: `ReaderSidebar.open(tab)`, `ReaderSidebar.close()`, `OutlinePanel.render(items)`, `SearchPanel.setResults(results)`.
- Adds commands: `show-outline`, `show-annotations` only in later plan, and `search-document` without default hotkeys.
- Consumes: `DocumentSession.getOutline`, `DocumentViewport.search/selectSearchHit`.

**Required sources:**

- Obsidian `Plugin.addCommand` and command naming rules from the [plugin self-critique checklist](https://docs.obsidian.md/oo/plugin) — no plugin-name prefix and no default hotkeys.
- PDF.js 6.2.108 installed `pdf_find_controller.d.ts` and `pdf_viewer.mjs` — public `PDFLinkService.page`, `find`, and `updatefindcontrolstate` synchronization for adapter-level document text search.

**Risk checks:**

- Keyboard conflict from `## Risk Scan`.

- [ ] **Step 1: Write failing hidden-sidebar and search-scope tests**

```ts
it('does not create sidebar DOM until an explicit intent', () => {
  controller.attach(shell);
  expect(shell.sidebar).toBeNull();
  controller.dispatch({ type: 'open-sidebar', tab: 'outline' });
  expect(shell.sidebar?.activeTab).toBe('outline');
});

it('Ctrl/Cmd+F opens document Search and focuses its field', () => {
  dispatchFindShortcut(shell.root);
  expect(sidebar.activeTab).toBe('search');
  expect(document.activeElement).toBe(searchPanel.input);
  expect(annotationSearchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run src/reader/sidebar.test.ts src/reader/outline-panel.test.ts src/reader/search-panel.test.ts`

Expected: FAIL with missing sidebar panels.

- [ ] **Step 3: Implement explicit sidebar triggers and lazy DOM**

The toolbar toggle opens the last selected tab. `search-document` and view-local `Ctrl/Cmd+F` open Search; `show-outline` opens Outline. A deep navigation intent never opens the sidebar. Closing removes the mobile overlay from the focus order but may retain desktop panel DOM only after first use.

- [ ] **Step 4: Implement outline and Search behaviors**

Outline renders a recursive tree with native chevrons, roving tabindex, Enter navigation, and current-location state. Search has one input, previous/next, count, and a fixed-size moving snippet window. Each new query trims once, aborts the previous `PdfTextSearch` scan, and uses that normalized query for PDF.js find. Partial results update the count/list in page order. Selecting a hit calls `DocumentViewport.selectSearchHit`: the PDF adapter cancels any stale selection, sets the public `PDFLinkService.page`, dispatches a fresh public `find`, awaits a successful `updatefindcontrolstate`, then dispatches and awaits one `again` event per page-local `matchIndex`. The latest selection wins; timeout, abort, and destroy remove listeners, `highlightAll` stays false, and no private PDF.js fields are read. Empty query aborts extraction and clears PDF.js matches. Escape from anywhere in Search first clears the query and focuses the input, then closes Search and returns focus to the document. Tests synchronize a clicked snippet, the delayed PDF.js active match, and current page. No annotation terminology appears.

- [ ] **Step 5: Run focused tests and task gate**

Run: `pnpm vitest run src/reader && pnpm run verify:task`

Expected: PASS; explicit tests distinguish toolbar toggle, `Ctrl/Cmd+F`, outline command, close, and deep navigation.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/reader src/styles/reader.css
git commit -m "feat: add opt-in PDF outline and search"
```

### Task 8: Finish responsive, accessible UI and native settings

**Files:**

- Create: `src/reader/a11y.ts`
- Create: `src/reader/a11y.test.ts`
- Create: `src/settings-tab.ts`
- Create: `src/settings-tab.test.ts`
- Create: `src/styles/settings.css`
- Modify: `src/styles/reader.css`
- Modify: `src/main.ts`
- Modify: `src/plugin-data.ts`

**Interfaces:**

- Produces: `FocusReturn`, `PoliteAnnouncer`, `AbyssDocumentsSettingTab`.
- Consumes: `PluginDataStore.update`, `ReadingProfileService`, toolbar/sidebar DOM.

**Required sources:**

- [Obsidian settings UI](https://docs.obsidian.md/Plugins/User%20interface/Settings) and installed `Setting` API — native controls and headings.
- [Obsidian pop-out windows guide](https://docs.obsidian.md/Plugins/Guides/Pop-out%20windows) — use `element.doc`/`element.win`, not global `document` for view DOM.
- [Plugin self-critique checklist](https://docs.obsidian.md/oo/plugin) — sentence case, mobile/Node boundaries, scoped CSS, and no default command hotkeys.

- [ ] **Step 1: Write failing focus, mobile, and settings tests**

```ts
it('returns focus to the invoking toolbar button after closing the sidebar', () => {
  focusReturn.capture(toggleButton);
  focusReturn.restore();
  expect(document.activeElement).toBe(toggleButton);
});

it('renders all settings sections collapsed', () => {
  tab.display();
  expect(
    [...tab.containerEl.querySelectorAll('[aria-expanded]')].every(
      (el) => el.getAttribute('aria-expanded') === 'false',
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run src/reader/a11y.test.ts src/settings-tab.test.ts`

Expected: FAIL with missing accessibility/settings classes.

- [ ] **Step 3: Implement native settings and focus helpers**

Create collapsed sections **Reading appearance** and **Advanced** for this foundation. Use native `Setting` rows for default profile, remember-per-document, custom foreground/page tint/brightness/contrast/image dim, and debug logging. Clamp and unit-test numeric values to ranges the renderer actually honors. Do not render future Annotation/OCR sections until those capabilities ship.

- [ ] **Step 4: Add responsive and reduced-motion CSS**

Desktop sidebar docks at the requested width; phone sidebar is a safe-area-aware overlay/sheet. Keep hit targets at least Obsidian's interactive size variables. Add `@media (prefers-reduced-motion: reduce)` to remove smooth scrolling/transitions. Use CSS variables only, except PDF page colors supplied by the selected reading profile.

- [ ] **Step 5: Run UI tests, style lint, and task gate**

Run: `pnpm vitest run src/reader src/settings-tab.test.ts && pnpm lint:css && pnpm run verify:task`

Expected: PASS with no unscoped selector, missing label, focus trap, or persistent sidebar default.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/plugin-data.ts src/settings-tab.ts src/settings-tab.test.ts src/reader/a11y.ts src/reader/a11y.test.ts src/styles styles.css
git commit -m "feat: polish responsive reader experience"
```

### Task 9: Add deterministic fixtures, e2e coverage, and performance gates

**Files:**

- Modify: `.gitignore`
- Modify: `package.json`
- Create: `tests/fixtures/pdf-fixtures.mts`
- Create: `scripts/generate-dev-vault.mts`
- Create: `tests/e2e/reader.e2e.ts`
- Create: `tests/e2e/reader.mobile.e2e.ts`
- Modify: `tests/e2e/wdio.conf.mts`
- Modify: `tests/e2e/wdio.mobile.conf.mts`
- Create: `tests/performance/reader-budget.test.ts`
- Create: `scripts/benchmark-reader.mts`
- Create: `scripts/smoke-community-package.mts`
- Modify: `vitest.config.ts`
- Modify: `README.md`

**Interfaces:**

- Produces scripts `pnpm dev:vault`, `pnpm test:e2e:reader`, `pnpm test:package`, `pnpm benchmark:reader`, and versioned fixture metadata.
- Consumes: `pdf-lib@1.17.1` as a development-fixture generator, WebdriverIO Obsidian service, and the public reader DOM `data-*` hooks.

**Required sources:**

- [Obsidian CLI developer commands](https://obsidian.md/help/cli#Developer+commands) — real-app DOM, console, errors, eval, and screenshots.
- [WebdriverIO documentation](https://webdriver.io/docs/api) — semantic element waits and browser execution.
- [Obsidian mobile development checklist](https://docs.obsidian.md/oo/plugin) — Android-safe APIs and CSS.

**Risk checks:**

- Long-document, file-takeover, CSS-isolation, and keyboard-scope checks from `## Risk Scan`.

- [ ] **Step 1: Write failing real-reader e2e specs**

```ts
it('opens with only the PDF surface and no sidebar', async () => {
  await browser.executeObsidian(
    async ({ app }, path) => app.workspace.openLinkText(path, '', false),
    'Documents/text-12-pages.pdf',
  );
  await expect($('[data-abyss-document]')).toBeDisplayed();
  await expect($('[data-region="sidebar"]')).not.toExist();
});

it('Ctrl/Cmd+F searches the PDF document only', async () => {
  await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'f']);
  await expect($('[data-tab="search"][aria-selected="true"]')).toExist();
  await $('[data-document-search]').setValue('gradient');
  await expect($('[data-search-count]')).toHaveText(/[1-9]/);
  await expect($('[data-annotation-search]')).not.toExist();
});
```

- [ ] **Step 2: Run e2e specs and confirm RED**

Run: `pnpm run build && pnpm run test:e2e -- --spec tests/e2e/reader.e2e.ts`

Expected: FAIL because fixtures/scripts and stable reader hooks are absent.

- [ ] **Step 3: Generate deterministic dev/test PDFs**

Add `pdf-lib@1.17.1` as a dev dependency. `pdf-fixtures.mts` creates:

- `text-12-pages.pdf` with known “gradient” matches on pages 2, 7, and 11;
- `outline-20-pages.pdf` with two-level deterministic outline dictionaries;
- `text-700-pages.pdf` with page-numbered text and repeated search terms;
- `raster-heavy-24-pages.pdf` using one embedded image reused across pages;
- `invalid.pdf` containing deterministic invalid bytes.

`scripts/generate-dev-vault.mts` recreates only the explicit `dev-documents-vault/Documents` fixture directory, writes `.obsidian` development configuration, links/copies the built plugin into `.obsidian/plugins/abyss-documents`, creates `artifacts/manual-qa/`, and launches/registers that exact vault path with the platform-appropriate Obsidian executable when the CLI does not know it yet. It must never delete the vault root or any path outside the explicit generated fixture/config/plugin directories. Add `/dev-documents-vault/` and `/artifacts/manual-qa/` to `.gitignore`.

- [ ] **Step 4: Implement desktop/mobile e2e and performance assertions**

Cover PDF-only initial state, outline open/navigation, `Ctrl/Cmd+F`, page entry, profile switching, sidebar close/focus return, plugin reload, invalid-PDF retry, mobile overlay, pinch-capable mode, and bounded DOM on the 700-page fixture. `reader-budget.test.ts` parses the build metafile and instrumentation counters to assert:

```ts
expect(metrics.mainJsBytes).toBeLessThanOrEqual(2_097_152);
expect(metrics.pdfRuntimeLoadsDuringPluginOnload).toBe(0);
expect(metrics.maxRenderedPagesDuringLongNavigation).toBeLessThanOrEqual(7);
```

`smoke-community-package.mts` copies only `main.js`, `manifest.json`, and `styles.css` into a clean temporary plugin directory, makes repository `node_modules` unavailable to that copy, denies network through the test harness, opens a real PDF in Obsidian, asserts library/worker version `6.2.108`, then disables the plugin and checks clean worker teardown. It never edits or deletes the repository or development vault.

Instrument named marks for plugin activation, first reader intent, PDF imports, gzip decode, Blob creation, Worker start, first text layer, and first usable page. `benchmark-reader.mts` records hardware, OS, Obsidian/plugin/PDF.js versions, fixture hashes, iteration count, and cold/warm conditions; it runs enough iterations to report p50/p95 and fails unless activation is below 100 ms p95 with zero PDF work, and first usable page is below 2 seconds desktop / 4 seconds Android on the designated reference devices. Keep raw samples as ignored artifacts and the summarized benchmark in the QA report.

- [ ] **Step 5: Document local-first behavior and commands**

Update README with supported platforms, PDF-only opening behavior, search shortcut, reading profiles, privacy/local operation, development-vault generation, and known scope boundary that annotation writing/OCR arrive in separately qualified milestones.

- [ ] **Step 6: Run automated gates**

Run:

```bash
pnpm dev:vault
pnpm run verify
pnpm run test:package
pnpm run benchmark:reader
pnpm run test:e2e:reader
pnpm run test:e2e:android
```

Expected: all commands exit 0; desktop and Android report no uncaught reader error, no eager PDF runtime load, and bounded long-document rendering.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json pnpm-lock.yaml README.md scripts tests vitest.config.ts
git commit -m "test: qualify the PDF reader foundation"
```

### Task 10: Perform final real-vault visual and UX acceptance

**Files:**

- Create: `docs/qa/2026-08-09-pdf-reader-foundation.md`
- Generate ignored: `dev-documents-vault/`
- Generate ignored: `artifacts/manual-qa/*.png`
- Modify only if defects are found: the smallest relevant source/test files from Tasks 3-9.

**Interfaces:**

- Consumes: running Obsidian 1.12+, Obsidian CLI developer commands, generated development vault, and all production reader flows.
- Produces: an evidence-backed QA report; no completion claim is permitted without screenshot inspection and clean console/error evidence.

**Project-specific requirements:**

- This is the final task and must remain the final task in the plan.
- Use the running Obsidian app and CLI; do not infer visual correctness from jsdom or e2e assertions.

**Failure-handling requirements:**

- Any visible defect, console error, rejected promise, clipped menu, incorrect icon, focus loss, or foreign-looking style fails acceptance. Add a regression test, fix it, rerun `pnpm run verify`, reload the plugin, and retake the affected screenshots before continuing.

- [ ] **Step 1: Build and regenerate the isolated development vault**

Run:

```bash
pnpm run build
pnpm dev:vault
obsidian vault=dev-documents-vault dev:console clear
obsidian vault=dev-documents-vault dev:errors clear
obsidian vault=dev-documents-vault plugin:reload id=abyss-documents
obsidian vault=dev-documents-vault dev:errors
obsidian vault=dev-documents-vault dev:console level=error
```

Expected: buffers are cleared before reload; plugin reload succeeds; the immediately recorded post-reload buffers contain no initialization error. Do not clear either buffer again during this acceptance run.

- [ ] **Step 2: Inspect the PDF-only initial state in real Obsidian**

Run:

```bash
obsidian vault=dev-documents-vault open path="Documents/text-12-pages.pdf"
obsidian vault=dev-documents-vault dev:dom selector="[data-abyss-document]" attr=class
obsidian vault=dev-documents-vault dev:dom selector="[data-region=sidebar]" total
obsidian vault=dev-documents-vault dev:screenshot path="$PWD/artifacts/manual-qa/01-pdf-only-light.png"
```

Expected: one reader root, zero sidebar elements, centered readable page, compact toolbar, native spacing, and no duplicate document title.

- [ ] **Step 3: Exercise and capture every user-visible state**

Use `obsidian eval code="..."` only to dispatch real DOM clicks/keys, not to mutate internal plugin state. Capture at minimum:

1. `02-auto-dark-outline.png` — Auto under dark Obsidian theme, sidebar explicitly opened to Outline.
2. `03-document-search.png` — `Cmd/Ctrl+F`, “gradient” results, active result synchronized to page.
3. `04-sepia-long-document.png` — page 438 of the 700-page fixture, Sepia profile.
4. `05-mobile-search-sheet.png` — `obsidian dev:mobile on`, Search as overlay/sheet with visible focus.
5. `06-overflow-and-profiles.png` — narrow toolbar overflow and profile menu, unclipped.
6. `07-invalid-pdf-recovery.png` — concise inline failure with Retry and one non-duplicated Notice.
7. `08-light-profile-zoom-100.png` and `09-light-profile-zoom-175.png` — Light profile with canvas/text-layer alignment at two zoom levels.
8. `10-dark-profile.png` — explicit Dark profile, distinct from Auto-Dark.
9. `11-custom-profile.png` — non-default Custom tint/brightness/contrast/image dim values.
10. `12-auto-light.png` — Auto under light Obsidian theme.

After each state run `obsidian dev:dom` for the relevant active element, `aria-*`, dimensions, and canvas/text-layer counts.

- [ ] **Step 4: Visually inspect every screenshot, not just create it**

Open each PNG with the local image-inspection tool. Record concrete observations in `docs/qa/2026-08-09-pdf-reader-foundation.md` for:

- fit with current Obsidian light/dark theme and CSS variables;
- Lucide icon clarity, size, active state, tooltip, and alignment;
- PDF/text-layer alignment at multiple zoom levels;
- absence of unnecessary status/autosave/index information;
- sidebar remaining hidden until requested;
- comfortable reading width, contrast, page spacing, and scroll continuity;
- keyboard focus visibility and return;
- mobile safe areas, touch targets, menu clipping, and overlay dismissal;
- no PDF.js styling leaking into unrelated Obsidian DOM.

If any item cannot be confidently marked PASS from the screenshot/DOM evidence, treat it as a defect and iterate.

- [ ] **Step 5: Inspect runtime health and long-document bounds**

Run:

```bash
obsidian vault=dev-documents-vault dev:errors
obsidian vault=dev-documents-vault dev:console level=error
obsidian vault=dev-documents-vault dev:console level=warn
obsidian vault=dev-documents-vault dev:dom selector=".abyss-documents canvas" total
obsidian vault=dev-documents-vault dev:dom selector=".abyss-documents .textLayer" total
obsidian vault=dev-documents-vault eval code="JSON.stringify(performance.getEntriesByType('measure').filter(x => x.name.startsWith('abyss-documents')))"
```

Expected: no uncaught errors, no repeated warnings, bounded canvas/text-layer counts, first usable page within the documented reference budget, and no PDF work recorded during plugin activation.

- [ ] **Step 6: Run the final automated gate after all visual fixes**

Run: `pnpm run verify && pnpm run test:package && pnpm run benchmark:reader && pnpm run test:e2e:reader && pnpm run test:e2e:android`

Expected: all commands exit 0 after the final screenshot iteration.

- [ ] **Step 7: Complete and commit the QA evidence**

The QA report lists environment versions, fixture hashes, every command run, screenshot-by-screenshot PASS observations, measured timings/counts, console/error output, and any defect/fix/regression-test loop. It must not say “looks good” without evidence.

```bash
git add docs/qa/2026-08-09-pdf-reader-foundation.md
git commit -m "docs: verify PDF reader in real Obsidian"
```
