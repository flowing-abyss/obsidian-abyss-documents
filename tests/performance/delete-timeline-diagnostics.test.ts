import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeleteTimeline } from '../e2e/delete-timeline-diagnostics.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'abyss-delete-timeline-'));
  directories.push(directory);
  const destination = join(directory, 'renderer.trace.json');
  const emitter = new EventEmitter();
  const chunks = [
    { data: '{"traceEvents":[', eof: false },
    { data: Buffer.from(']}').toString('base64'), base64Encoded: true, eof: true },
  ];
  const options = { lost: false, failRead: false, failStart: false, stream: true, complete: true };
  const send = vi.fn(async (method: string, _parameters?: unknown) => {
    if (method === 'Tracing.start' && options.failStart) throw new Error('start failed');
    if (method === 'Tracing.end' && options.complete) {
      emitter.emit('Tracing.tracingComplete', {
        dataLossOccurred: options.lost,
        ...(options.stream ? { stream: 'trace-stream' } : {}),
      });
    }
    if (method === 'IO.read') {
      if (options.failRead) throw new Error('read failed');
      return chunks.shift() ?? { data: '', eof: true };
    }
    return {};
  });
  const detach = vi.fn(async () => undefined);
  const session = {
    send,
    detach,
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  } as unknown as CDPSession;
  return { destination, emitter, options, send, detach, session };
}

describe('temporary renderer deletion timeline artifacts', () => {
  it('starts before the scenario and streams all chunks only after stopping', async () => {
    const current = await fixture();
    const capture = await startDeleteTimeline(current.session, current.destination);
    expect(current.send).toHaveBeenCalledExactlyOnceWith(
      'Tracing.start',
      expect.objectContaining({ transferMode: 'ReturnAsStream' }),
    );
    await expect(readFile(current.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const metadata = { marker: { startTime: 20 }, trace: { maxRafGapMs: 150 } };

    await capture.stop(metadata);
    await capture.stop(metadata);

    expect(await readFile(current.destination, 'utf8')).toBe('{"traceEvents":[]}');
    expect(
      JSON.parse(await readFile(`${current.destination}.metadata.json`, 'utf8')),
    ).toMatchObject({
      diagnosticOnly: true,
      dataLossOccurred: false,
      bytes: 18,
      scenario: metadata,
    });
    expect(current.send.mock.calls.map(([method]) => method)).toEqual([
      'Tracing.start',
      'Tracing.end',
      'IO.read',
      'IO.read',
      'IO.close',
    ]);
    expect(current.detach).toHaveBeenCalledOnce();
    expect(current.emitter.listenerCount('Tracing.tracingComplete')).toBe(0);
  });

  it('preserves trace and metadata when the protocol reports lost events', async () => {
    const current = await fixture();
    current.options.lost = true;
    const capture = await startDeleteTimeline(current.session, current.destination);

    await expect(capture.stop({})).rejects.toThrow(/lost events/u);

    expect(await readFile(current.destination, 'utf8')).toBe('{"traceEvents":[]}');
    const metadata: unknown = JSON.parse(
      await readFile(`${current.destination}.metadata.json`, 'utf8'),
    );
    expect(metadata).toHaveProperty('dataLossOccurred', true);
    expect(metadata).toHaveProperty('error', expect.stringContaining('lost events'));
    expect(current.send).toHaveBeenLastCalledWith('IO.close', { handle: 'trace-stream' });
    expect(current.detach).toHaveBeenCalledOnce();
  });

  it('closes the protocol stream and session after a read failure', async () => {
    const current = await fixture();
    current.options.failRead = true;
    const capture = await startDeleteTimeline(current.session, current.destination);

    await expect(capture.stop({})).rejects.toThrow('read failed');

    expect(current.send).toHaveBeenLastCalledWith('IO.close', { handle: 'trace-stream' });
    expect(current.detach).toHaveBeenCalledOnce();
    expect(current.emitter.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(
      JSON.parse(await readFile(`${current.destination}.metadata.json`, 'utf8')),
    ).toHaveProperty('error', expect.stringContaining('read failed'));
  });

  it('rejects a missing stream while preserving diagnostic metadata', async () => {
    const current = await fixture();
    current.options.stream = false;
    const capture = await startDeleteTimeline(current.session, current.destination);

    await expect(capture.stop({})).rejects.toThrow(/stream/u);

    expect(current.detach).toHaveBeenCalledOnce();
    expect(current.emitter.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(
      JSON.parse(await readFile(`${current.destination}.metadata.json`, 'utf8')),
    ).toHaveProperty('error', expect.stringContaining('stream'));
  });

  it('bounds completion waits and removes listeners after timeout', async () => {
    const current = await fixture();
    current.options.complete = false;
    const capture = await startDeleteTimeline(current.session, current.destination);
    vi.useFakeTimers();
    const stopping = capture.stop({});
    const rejected = expect(stopping).rejects.toThrow(/did not complete/u);

    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;

    expect(current.detach).toHaveBeenCalledOnce();
    expect(current.emitter.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a failed start without installing measurement work', async () => {
    const current = await fixture();
    current.options.failStart = true;

    await expect(startDeleteTimeline(current.session, current.destination)).rejects.toThrow(
      'start failed',
    );

    expect(current.detach).toHaveBeenCalledOnce();
    expect(current.emitter.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(
      JSON.parse(await readFile(`${current.destination}.metadata.json`, 'utf8')),
    ).toHaveProperty('error', expect.stringContaining('start failed'));
  });
});
