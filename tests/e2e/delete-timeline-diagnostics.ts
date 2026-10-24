import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CDPSession } from 'puppeteer-core';

type TimelineSession = Pick<CDPSession, 'send' | 'once' | 'off' | 'detach'>;
interface TraceComplete {
  readonly dataLossOccurred: boolean;
  readonly stream?: string;
}

export interface DeleteTimelineCapture {
  stop(metadata: unknown): Promise<void>;
}

// Temporary investigation of the legacy macOS frame gap. Remove after its cause
// is identified; these traced timings never replace the unprofiled frame budget.
// Chromium120 protocol: https://github.com/chromium/chromium/blob/120.0.6099.283/third_party/blink/public/devtools_protocol/browser_protocol.pdl#L9729
export async function startDeleteTimeline(
  session: TimelineSession,
  destination: string,
): Promise<DeleteTimelineCapture> {
  await mkdir(dirname(destination), { recursive: true });
  const removers: Array<() => void> = [];
  const completion = new Promise<TraceComplete>((resolve) => {
    session.once('Tracing.tracingComplete', resolve);
    removers.push(() => session.off('Tracing.tracingComplete', resolve));
  });
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      streamCompression: 'none',
      traceConfig: {
        recordMode: 'recordUntilFull',
        traceBufferSizeInKb: 65_536,
        enableSampling: true,
        excludedCategories: ['*'],
        includedCategories: [
          'devtools.timeline',
          'v8',
          'v8.execute',
          'blink.user_timing',
          'toplevel',
          'latencyInfo',
          'cc',
          'gpu',
          'disabled-by-default-devtools.timeline',
          'disabled-by-default-devtools.timeline.frame',
          'disabled-by-default-devtools.timeline.stack',
          'disabled-by-default-v8.gc',
          'disabled-by-default-v8.cpu_profiler',
        ],
      },
    });
  } catch (cause) {
    for (const remove of removers) remove();
    try {
      await writeFile(
        `${destination}.metadata.json`,
        JSON.stringify({ diagnosticOnly: true, error: String(cause) }),
      );
    } finally {
      await session.detach();
    }
    throw cause;
  }
  let stopping: Promise<void> | null = null;
  return {
    stop(metadata) {
      stopping ??= finishDeleteTimeline(session, completion, destination, metadata).finally(
        async () => {
          for (const remove of removers) remove();
          await session.detach();
        },
      );
      return stopping;
    },
  };
}

async function finishDeleteTimeline(
  session: TimelineSession,
  completion: Promise<TraceComplete>,
  destination: string,
  metadata: unknown,
): Promise<void> {
  const outcome = {
    bytes: 0,
    dataLossOccurred: null as boolean | null,
    error: null as string | null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Renderer tracing did not complete.'));
    }, 15_000);
  });
  try {
    const result = await Promise.race([
      session.send('Tracing.end').then(() => completion),
      timeout,
    ]);
    outcome.dataLossOccurred = result.dataLossOccurred;
    if (result.stream === undefined) throw new Error('Renderer trace did not return a stream.');
    outcome.bytes = await persistTraceStream(session, result.stream, destination);
    if (result.dataLossOccurred) throw new Error('Renderer trace reports lost events.');
  } catch (cause) {
    outcome.error = String(cause);
    throw cause;
  } finally {
    clearTimeout(timer);
    await writeFile(
      `${destination}.metadata.json`,
      JSON.stringify({ diagnosticOnly: true, ...outcome, scenario: metadata }),
    );
  }
}

async function persistTraceStream(
  session: TimelineSession,
  handle: string,
  destination: string,
): Promise<number> {
  let bytes = 0;
  try {
    const file = await open(destination, 'wx');
    try {
      let ended = false;
      while (!ended) {
        const result = await session.send('IO.read', { handle, size: 1_048_576 });
        const chunk = Buffer.from(result.data, result.base64Encoded === true ? 'base64' : 'utf8');
        await file.writeFile(chunk);
        bytes += chunk.length;
        ended = result.eof;
      }
      return bytes;
    } finally {
      await file.close();
    }
  } finally {
    await session.send('IO.close', { handle });
  }
}
