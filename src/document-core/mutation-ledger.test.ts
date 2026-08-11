import { describe, expect, it, vi } from 'vitest';
import {
  asAnnotationId,
  asGeneratedAnnotationId,
  asUtcTimestamp,
  type AnnotationMutation,
  type AnnotationMutationTarget,
  type GeneratedAnnotationId,
} from './annotations.js';
import type { DocumentViewport } from './document.js';
import {
  type ActiveDocumentSaveAttempt,
  type DocumentSaveAttempt,
  type DocumentSaveService,
  type EditableDocumentSession,
  type VerifiedSaveResult,
} from './editable-document.js';
import { InvalidAnnotationMutationError, StaleGenerationError } from './errors.js';
import { MutationLedger } from './mutation-ledger.js';

const id = asAnnotationId('nm-1');
const target: AnnotationMutationTarget = { kind: 'stable', id };

function comment(comment = '[[Concept]] #tag'): AnnotationMutation {
  return { kind: 'set-comment', target, comment };
}

const unavailable = {
  available: false as const,
  reason: { code: 'signed-document' as const, message: 'Editing would invalidate a signature.' },
};

const session: EditableDocumentSession = {
  descriptor: {
    path: 'Research/paper.pdf',
    name: 'paper.pdf',
    fingerprint: 'fixture',
    pageCount: 1,
  },
  capabilities: new Set(),
  editingCapabilities: {
    mutation: unavailable,
    create: {
      highlight: unavailable,
      underline: unavailable,
      ink: unavailable,
      'text-note': unavailable,
      'free-text': unavailable,
    },
  },
  getOutline: async () => [],
  createViewport: async (): Promise<DocumentViewport> => {
    throw new Error('This save-boundary fixture does not create a viewport.');
  },
  close: async () => undefined,
  listAnnotations: async () => undefined,
  applyMutation: async () => {
    throw new Error('This save-boundary fixture does not apply mutations.');
  },
  captureGeneration: () => {
    throw new Error('The test captures directly from its ledger.');
  },
  prepareSave: () => {
    throw new Error('The test prepares directly from its ledger.');
  },
  resolveAnnotation: (reference) => ({
    status: 'unresolved',
    reason: 'external-delete',
    reference,
  }),
};

function verifiedResult(generation: number): VerifiedSaveResult {
  return {
    verified: true,
    generation,
    sha256: 'a'.repeat(64),
    byteSize: 42,
    committedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
  };
}

function runAttempt(
  attempt: DocumentSaveAttempt<EditableDocumentSession>,
  operation: (
    active: ActiveDocumentSaveAttempt<EditableDocumentSession>,
    result: VerifiedSaveResult,
  ) => void,
): Promise<VerifiedSaveResult> {
  const result = verifiedResult(attempt.captured.generation);
  return attempt.run(
    {
      save: async (active) => {
        operation(active, result);
        return result;
      },
    },
    new AbortController().signal,
  );
}

async function commitPending(ledger: MutationLedger<EditableDocumentSession>): Promise<void> {
  const captured = ledger.capture();
  await runAttempt(ledger.prepareSave(captured), (active, result) => {
    active.markWriting();
    active.markVerifying();
    active.commit(result);
  });
}

function setDescriptorPath(descriptor: { path: string }, path: string): void {
  descriptor.path = path;
}

describe('MutationLedger', () => {
  it('binds save execution to one owner and invokes a service only once', async () => {
    const ownedLedger = new MutationLedger(session);
    ownedLedger.append(comment());
    const captured = ownedLedger.capture();
    const result: VerifiedSaveResult = {
      verified: true,
      generation: captured.generation,
      sha256: 'a'.repeat(64),
      byteSize: 42,
      committedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
    };
    const save = vi.fn(async (active: ActiveDocumentSaveAttempt<EditableDocumentSession>) => {
      expect(active.session).toBe(session);
      active.markWriting();
      active.markVerifying();
      active.commit(result);
      return result;
    });
    const service: DocumentSaveService = { save };
    const attempt = ownedLedger.prepareSave(captured);

    const saved = await attempt.run(service, new AbortController().signal);
    expect(saved).toStrictEqual(result);
    expect(Object.isFrozen(saved)).toBe(true);
    await expect(attempt.run(service, new AbortController().signal)).rejects.toThrow(
      StaleGenerationError,
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(ownedLedger.state).toBe('committed');
  });

  it('rejects a prototype-preserving save-attempt copy before service work begins', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    const copied = Object.assign(
      Object.create(Reflect.getPrototypeOf(attempt)),
      attempt,
    ) as DocumentSaveAttempt<EditableDocumentSession>;
    const save = vi.fn();
    const service = { save } as unknown as DocumentSaveService;

    await expect(copied.run(service, new AbortController().signal)).rejects.toThrow(
      StaleGenerationError,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('records a service throw at the active stage without requiring an explicit fail call', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const cause = new Error('writer rejected');

    await expect(
      attempt.run(
        {
          save: async (active) => {
            active.markWriting();
            throw cause;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(cause);
    expect(ledger.lastFailure).toMatchObject({ stage: 'writing', cause });
    expect(ledger.pending()).toEqual([comment()]);
  });

  it('fails a service completion that returns without committing its verified result', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const result = verifiedResult(attempt.captured.generation);

    await expect(
      attempt.run({ save: async () => result }, new AbortController().signal),
    ).rejects.toThrow(/without commit/u);
    expect(ledger.lastFailure).toMatchObject({ stage: 'serializing' });
    expect(ledger.pending()).toEqual([comment()]);
  });

  it('refuses an unverified generation and makes its active attempt stale', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    let retained: ActiveDocumentSaveAttempt<EditableDocumentSession> | null = null;

    await expect(
      attempt.run(
        {
          save: async (active) => {
            retained = active;
            active.markWriting();
            active.markVerifying();
            active.commit(verifiedResult(active.captured.generation + 1));
            return verifiedResult(active.captured.generation);
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/verified result/u);
    expect(ledger.lastFailure).toMatchObject({ stage: 'verifying' });
    expect(() => retained?.markWriting()).toThrow(StaleGenerationError);
  });

  it('retains mutations when a service throws after staging a verified commit', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const result = verifiedResult(attempt.captured.generation);
    const cause = new Error('post-verify failure');

    await expect(
      attempt.run(
        {
          save: async (active) => {
            active.markWriting();
            active.markVerifying();
            active.commit(result);
            throw cause;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(cause);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.lastFailure).toMatchObject({ stage: 'verifying', cause });
  });

  it('keeps a staged commit active until the service result is reconciled', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const committed = verifiedResult(attempt.captured.generation);
    const returned = { ...committed, sha256: 'b'.repeat(64) };

    await expect(
      attempt.run(
        {
          save: async (active) => {
            active.markWriting();
            active.markVerifying();
            active.commit(committed);
            expect(() => ledger.capture()).toThrow(/verifying/u);
            return returned;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/verified result/u);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
  });

  it.each([
    ['sha256', { sha256: 'not-a-sha256' }],
    ['byteSize', { byteSize: -1 }],
    ['committedAt', { committedAt: 'not-a-timestamp' }],
  ] as const)(
    'rejects an invalid verified-result %s before acknowledging mutations',
    async (_, patch) => {
      const ledger = new MutationLedger(session);
      ledger.append(comment());
      const attempt = ledger.prepareSave(ledger.capture());
      const malformed = { ...verifiedResult(attempt.captured.generation), ...patch };

      await expect(
        attempt.run(
          {
            save: async (active) => {
              active.markWriting();
              active.markVerifying();
              active.commit(malformed as VerifiedSaveResult);
              return malformed as VerifiedSaveResult;
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/verified result/u);
      expect(ledger.pending()).toEqual([comment()]);
      expect(ledger.committedGeneration).toBe(0);
    },
  );

  it('rejects a changed owner path before service work begins', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const save = vi.fn();
    setDescriptorPath(descriptor, 'Research/other.pdf');

    await expect(attempt.run({ save }, new AbortController().signal)).rejects.toThrow(
      /path changed/u,
    );
    expect(save).not.toHaveBeenCalled();
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('does not let a copied attempt clear a valid prepared capture on path mismatch', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const copied = Object.assign(
      Object.create(Reflect.getPrototypeOf(attempt)),
      attempt,
    ) as DocumentSaveAttempt<EditableDocumentSession>;
    const save = vi.fn();
    setDescriptorPath(descriptor, 'Research/other.pdf');

    await expect(copied.run({ save }, new AbortController().signal)).rejects.toThrow(
      StaleGenerationError,
    );
    expect(ledger.state).toBe('serializing');
    expect(save).not.toHaveBeenCalled();

    await expect(attempt.run({ save }, new AbortController().signal)).rejects.toThrow(
      /path changed/u,
    );
    expect(ledger.state).toBe('dirty');
    expect(ledger.pending()).toEqual([comment()]);
    expect(save).not.toHaveBeenCalled();

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('fails retryably when the owner path changes during serialization', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());

    await expect(
      attempt.run(
        {
          save: async (active) => {
            setDescriptorPath(descriptor, 'Research/other.pdf');
            active.markWriting();
            return verifiedResult(active.captured.generation);
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/path changed/u);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('fails retryably when the owner path changes during writing', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());

    await expect(
      attempt.run(
        {
          save: async (active) => {
            active.markWriting();
            setDescriptorPath(descriptor, 'Research/other.pdf');
            active.markVerifying();
            return verifiedResult(active.captured.generation);
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/path changed/u);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('fails retryably when the owner path changes after a staged commit', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());

    await expect(
      attempt.run(
        {
          save: async (active) => {
            const result = verifiedResult(active.captured.generation);
            active.markWriting();
            active.markVerifying();
            active.commit(result);
            setDescriptorPath(descriptor, 'Research/other.pdf');
            return result;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/path changed/u);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('allows explicit failure cleanup after the owner path changes', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    const cause = new Error('path changed during serialization');

    await expect(
      attempt.run(
        {
          save: async (active) => {
            setDescriptorPath(descriptor, 'Research/other.pdf');
            active.fail(cause);
            throw cause;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(cause);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.lastFailure).toMatchObject({ stage: 'serializing', cause });
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('revokes an active attempt when a service catches a path mismatch', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    let pathFailure: unknown;

    await expect(
      attempt.run(
        {
          save: async (active) => {
            const result = verifiedResult(active.captured.generation);
            setDescriptorPath(descriptor, 'Research/other.pdf');
            try {
              active.markWriting();
            } catch (cause) {
              pathFailure = cause;
            }
            setDescriptorPath(descriptor, session.descriptor.path);
            active.markWriting();
            active.markVerifying();
            active.commit(result);
            return result;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(StaleGenerationError);
    expect(pathFailure).toBeInstanceOf(Error);
    expect(pathFailure).toMatchObject({ action: 'save after document path changed' });
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('revokes an active attempt when staged-result normalization changes the owner path', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());
    let pathFailure: unknown;

    await expect(
      attempt.run(
        {
          save: async (active) => {
            const normal = verifiedResult(active.captured.generation);
            const pathChangingResult = {
              get verified() {
                setDescriptorPath(descriptor, 'Research/other.pdf');
                return true as const;
              },
              generation: normal.generation,
              sha256: normal.sha256,
              byteSize: normal.byteSize,
              committedAt: normal.committedAt,
            } satisfies VerifiedSaveResult;
            active.markWriting();
            active.markVerifying();
            try {
              active.commit(pathChangingResult);
            } catch (cause) {
              pathFailure = cause;
            }
            setDescriptorPath(descriptor, session.descriptor.path);
            active.commit(normal);
            return normal;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(StaleGenerationError);
    expect(pathFailure).toBeInstanceOf(Error);
    expect(pathFailure).toMatchObject({ action: 'save after document path changed' });
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('rejects a returned result that changes the owner path during final normalization', async () => {
    const descriptor = { ...session.descriptor };
    const mutableSession: EditableDocumentSession = { ...session, descriptor };
    const ledger = new MutationLedger(mutableSession);
    ledger.append(comment());
    const attempt = ledger.prepareSave(ledger.capture());

    await expect(
      attempt.run(
        {
          save: async (active) => {
            const normal = verifiedResult(active.captured.generation);
            active.markWriting();
            active.markVerifying();
            active.commit(normal);
            return {
              get verified() {
                setDescriptorPath(descriptor, 'Research/other.pdf');
                return true as const;
              },
              generation: normal.generation,
              sha256: normal.sha256,
              byteSize: normal.byteSize,
              committedAt: normal.committedAt,
            } satisfies VerifiedSaveResult;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/path changed/u);
    expect(ledger.pending()).toEqual([comment()]);
    expect(ledger.committedGeneration).toBe(0);
    expect(ledger.state).toBe('dirty');

    setDescriptorPath(descriptor, session.descriptor.path);
    await commitPending(ledger);
    expect(ledger.state).toBe('committed');
  });

  it('keeps edits made during save in the next generation when the captured save fails', async () => {
    const ledger = new MutationLedger(session);
    const first = ledger.append(comment());
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    const second = ledger.append({ kind: 'set-color', target, color: '#ffd400' });

    expect(captured.generation).toBe(first.generation);
    expect(second.generation).toBeGreaterThan(captured.generation);

    const cause = new Error('write');
    await expect(
      runAttempt(attempt, (active) => {
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);

    expect(ledger.state).toBe('dirty');
    expect(ledger.pending()).toEqual([first.mutation, second.mutation]);
    expect(ledger.lastFailure).toMatchObject({ stage: 'serializing', generation: 1 });
  });

  it.each([
    ['serializing', () => undefined],
    [
      'writing',
      (attempt: ActiveDocumentSaveAttempt<EditableDocumentSession>) => {
        attempt.markWriting();
      },
    ],
    [
      'verifying',
      (attempt: ActiveDocumentSaveAttempt<EditableDocumentSession>) => {
        attempt.markWriting();
        attempt.markVerifying();
      },
    ],
  ] as const)('retains the complete pending ledger after %s failure', async (stage, advance) => {
    const ledger = new MutationLedger(session);
    const entry = ledger.append(comment(stage));
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    const cause = new Error(stage);
    await expect(
      runAttempt(attempt, (active) => {
        advance(active);
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);

    expect(ledger.pending()).toEqual([entry.mutation]);
    expect(ledger.lastFailure).toMatchObject({ stage, cause });
  });

  it('commits only the captured generation and leaves concurrent edits dirty', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment('captured'));
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    const next = ledger.append({ kind: 'set-color', target, color: '#00a2ff' });

    await runAttempt(attempt, (active, result) => {
      active.markWriting();
      active.markVerifying();
      active.commit(result);
    });

    expect(ledger.state).toBe('dirty');
    expect(ledger.pending()).toEqual([next.mutation]);
    expect(ledger.committedGeneration).toBe(captured.generation);
  });

  it('rejects stale async completions after failure and retry capture', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const stale = ledger.capture();
    const cause = new Error('serialize');
    await expect(
      runAttempt(ledger.prepareSave(stale), (active) => {
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);
    const retry = ledger.capture();

    expect(retry.generation).toBe(stale.generation);
    expect(retry.captureId).not.toBe(stale.captureId);
    expect(() => {
      ledger.prepareSave(stale);
    }).toThrow(StaleGenerationError);
    expect(ledger.state).toBe('serializing');
  });

  it('rejects a second capture while serialization is active', () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    ledger.capture();

    expect(() => {
      ledger.capture();
    }).toThrow(/serializing/u);
  });

  it('can fail a clean capture without inventing a dirty generation', async () => {
    const ledger = new MutationLedger(session);
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);

    expect(captured).toMatchObject({ generation: 0, mutations: [] });
    const cause = new Error('clean serialization');
    await expect(
      runAttempt(attempt, (active) => {
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);

    expect(ledger.state).toBe('committed');
    expect(ledger.pending()).toEqual([]);
  });

  it('rejects a same-numbered capture from another ledger', () => {
    const first = new MutationLedger(session);
    const second = new MutationLedger(session);
    first.append(comment('first'));
    second.append(comment('second'));
    const foreign = first.capture();
    second.capture();

    expect(() => {
      second.prepareSave(foreign);
    }).toThrow(StaleGenerationError);
    expect(second.state).toBe('serializing');
  });

  it('rejects a foreign capture before serializer or writer work begins', async () => {
    const owner = new MutationLedger(session);
    const foreignLedger = new MutationLedger(session);
    owner.append(comment('owner'));
    foreignLedger.append(comment('foreign'));
    owner.capture();
    const foreign = foreignLedger.capture();
    const save = vi.fn();
    const service = { save } as unknown as DocumentSaveService;

    await expect(async () =>
      owner.prepareSave(foreign).run(service, new AbortController().signal),
    ).rejects.toThrow(StaleGenerationError);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a structurally copied capture with a forged generation', () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const forged = Object.freeze({ ...captured, generation: 999 });

    expect(() => {
      ledger.prepareSave(forged);
    }).toThrow(StaleGenerationError);
    expect(ledger.state).toBe('serializing');
  });

  it('rejects a spread copy before serializer or writer work begins', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const spreadCopy = Object.freeze({ ...captured });
    const save = vi.fn();
    const service = { save } as unknown as DocumentSaveService;

    await expect(async () =>
      ledger.prepareSave(spreadCopy).run(service, new AbortController().signal),
    ).rejects.toThrow(StaleGenerationError);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a stale capture after a failed attempt and retry capture', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const stale = ledger.capture();
    const cause = new Error('serialize');
    await expect(
      runAttempt(ledger.prepareSave(stale), (active) => {
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);
    ledger.capture();
    const save = vi.fn();
    const service = { save } as unknown as DocumentSaveService;

    await expect(async () =>
      ledger.prepareSave(stale).run(service, new AbortController().signal),
    ).rejects.toThrow(StaleGenerationError);
    expect(save).not.toHaveBeenCalled();
  });

  it('binds an opaque save attempt to its session and exact capture', () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();

    const attempt = ledger.prepareSave(captured);

    expect(attempt.session).toBe(session);
    expect(attempt.session.descriptor.path).toBe('Research/paper.pdf');
    expect(attempt.captured).toBe(captured);
    expect(Object.isFrozen(attempt)).toBe(true);
  });

  it('allows only one prepared attempt and rejects reuse after failure', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);

    expect(() => {
      ledger.prepareSave(captured);
    }).toThrow(/prepare another save/u);
    const cause = new Error('serialize');
    await expect(
      runAttempt(attempt, (active) => {
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);
    await expect(runAttempt(attempt, () => undefined)).rejects.toThrow(StaleGenerationError);
  });

  it('journals the UUID promotion needed to edit a legacy annotation', () => {
    const ledger = new MutationLedger(session);
    const promoteTo = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');

    const entry = ledger.append({
      kind: 'set-comment',
      target: { kind: 'legacy', fingerprint: 'page-2:quad-10-20', promoteTo },
      comment: 'First supported edit',
    });

    expect(entry.mutation).toMatchObject({
      target: { kind: 'legacy', fingerprint: 'page-2:quad-10-20', promoteTo },
    });
  });

  it('does not let callers mutate journaled entries or captured snapshots', () => {
    const input = comment('original');
    const ledger = new MutationLedger(session);
    const entry = ledger.append(input);
    const captured = ledger.capture();

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.mutation)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.mutations)).toBe(true);
    expect(() => {
      (input as { comment: string }).comment = 'changed outside';
    }).not.toThrow();
    expect(captured.mutations).toEqual([comment('original')]);
  });

  it('drops unknown properties without freezing caller-owned objects', () => {
    const external = { mutable: true };
    const input = {
      kind: 'set-comment',
      comment: 'canonical',
      external,
      target: { ...target, external },
    } as unknown as AnnotationMutation;
    const ledger = new MutationLedger(session);

    const entry = ledger.append(input);

    expect(entry.mutation).toEqual(comment('canonical'));
    expect(entry.mutation).not.toHaveProperty('external');
    if (entry.mutation.kind !== 'set-comment') throw new Error('Expected a comment mutation.');
    expect(entry.mutation.target).not.toHaveProperty('external');
    expect(Object.isFrozen(external)).toBe(false);
    external.mutable = false;
    expect(external.mutable).toBe(false);
  });

  it('canonicalizes every mutation variant and nested record without caller extras', () => {
    const timestamp = asUtcTimestamp('2026-08-11T10:00:00.000Z');
    const generated = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');
    const external = { mutable: true };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const canonicalAnchor = {
      kind: 'fixed-page' as const,
      pageIndex: 0,
      coordinateSpace: 'page-points-top-left' as const,
      geometry: { kind: 'point' as const, point: { x: 1, y: 2 } },
    };
    const anchorWithExtras = {
      ...canonicalAnchor,
      external,
      geometry: {
        ...canonicalAnchor.geometry,
        external,
        point: { ...canonicalAnchor.geometry.point, external },
      },
    };
    const targetWithExtras = { ...target, external };
    const commonCreate = {
      kind: 'create' as const,
      id: generated,
      type: 'text-note' as const,
      color: null,
      selectedText: null,
      author: '',
      createdAt: timestamp,
      modifiedAt: timestamp,
      comment: '',
    };
    const cases = [
      {
        input: { ...commonCreate, anchor: anchorWithExtras, cyclic },
        expected: { ...commonCreate, anchor: canonicalAnchor },
      },
      {
        input: {
          kind: 'set-geometry',
          target: targetWithExtras,
          anchor: anchorWithExtras,
          cyclic,
        },
        expected: { kind: 'set-geometry', target, anchor: canonicalAnchor },
      },
      {
        input: { kind: 'set-comment', target: targetWithExtras, comment: '', cyclic },
        expected: { kind: 'set-comment', target, comment: '' },
      },
      {
        input: { kind: 'set-color', target: targetWithExtras, color: null, cyclic },
        expected: { kind: 'set-color', target, color: null },
      },
      {
        input: { kind: 'convert-type', target: targetWithExtras, type: 'underline', cyclic },
        expected: { kind: 'convert-type', target, type: 'underline' },
      },
      {
        input: { kind: 'delete', target: targetWithExtras, cyclic },
        expected: { kind: 'delete', target },
      },
      {
        input: {
          kind: 'set-metadata',
          target: targetWithExtras,
          metadata: { author: 'Ada', modifiedAt: timestamp, external },
          cyclic,
        },
        expected: {
          kind: 'set-metadata',
          target,
          metadata: { author: 'Ada', modifiedAt: timestamp },
        },
      },
    ] as unknown as ReadonlyArray<{
      input: AnnotationMutation;
      expected: AnnotationMutation;
    }>;

    for (const { input, expected } of cases) {
      const ledger = new MutationLedger(session);
      expect(ledger.append(input).mutation).toEqual(expected);
    }
    expect(Object.isFrozen(external)).toBe(false);
    expect(Object.isFrozen(cyclic)).toBe(false);
  });

  it('ignores cyclic unknown properties without traversing caller state', () => {
    const cyclic: { self?: unknown; mutable: boolean } = { mutable: true };
    cyclic.self = cyclic;
    const input = {
      kind: 'set-comment',
      target,
      comment: 'cyclic',
      cyclic,
    } as unknown as AnnotationMutation;
    const ledger = new MutationLedger(session);

    const entry = ledger.append(input);

    expect(entry.mutation).toEqual(comment('cyclic'));
    expect(entry.mutation).not.toHaveProperty('cyclic');
    expect(Object.isFrozen(cyclic)).toBe(false);
    cyclic.mutable = false;
    expect(cyclic.mutable).toBe(false);
  });

  it('reads recognized scalar getters once before validation and freezing', () => {
    const external = { mutable: true };
    let reads = 0;
    const input = {
      kind: 'set-comment',
      target,
      get comment(): unknown {
        reads += 1;
        return reads === 1 ? 'single read' : external;
      },
    } as unknown as AnnotationMutation;
    const ledger = new MutationLedger(session);

    const entry = ledger.append(input);

    expect(entry.mutation).toEqual(comment('single read'));
    expect(reads).toBe(1);
    expect(Object.isFrozen(external)).toBe(false);
  });

  it('copies ink arrays without invoking caller-owned collection methods', () => {
    const externalPoint = { x: 90, y: 90 };
    const externalPaths = [[externalPoint]];
    const paths = [[{ x: 1, y: 2 }]];
    Object.defineProperty(paths, 'map', { value: () => externalPaths });
    const input = {
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'ink', paths },
      },
    } as AnnotationMutation;
    const ledger = new MutationLedger(session);

    const entry = ledger.append(input);

    expect(entry.mutation).toMatchObject({ anchor: { geometry: { paths: [[{ x: 1, y: 2 }]] } } });
    expect(Object.isFrozen(externalPaths)).toBe(false);
    expect(Object.isFrozen(externalPoint)).toBe(false);
  });

  it('does not traverse a cyclic value returned by an overridden array method', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const paths = [[{ x: 3, y: 4 }]];
    Object.defineProperty(paths, 'map', { value: () => cyclic });
    const input = {
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'ink', paths },
      },
    } as AnnotationMutation;
    const ledger = new MutationLedger(session);

    const entry = ledger.append(input);

    expect(entry.mutation).toMatchObject({ anchor: { geometry: { paths: [[{ x: 3, y: 4 }]] } } });
    expect(Object.isFrozen(cyclic)).toBe(false);
  });

  it('wraps nullish top-level mutations without journaling them', () => {
    for (const malformed of [null, undefined]) {
      const ledger = new MutationLedger(session);
      expect(() => ledger.append(malformed as unknown as AnnotationMutation)).toThrow(
        InvalidAnnotationMutationError,
      );
      expect(ledger.pending()).toEqual([]);
      expect(ledger.state).toBe('committed');
    }
  });

  it('copies and deeply freezes nested geometry before journaling', () => {
    const sourcePoint = { x: 10, y: 20 };
    const input: AnnotationMutation = {
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'ink', paths: [[sourcePoint]] },
      },
    };
    const ledger = new MutationLedger(session);

    ledger.append(input);
    const captured = ledger.capture();
    sourcePoint.x = 999;

    expect(captured.mutations).toMatchObject([
      {
        anchor: { geometry: { paths: [[{ x: 10, y: 20 }]] } },
      },
    ]);
    const journaled = captured.mutations[0];
    if (journaled?.kind !== 'set-geometry') {
      throw new Error('Expected a geometry mutation.');
    }
    if (journaled.anchor.kind !== 'fixed-page') {
      throw new Error('Expected a fixed-page anchor.');
    }
    if (journaled.anchor.geometry.kind !== 'ink') {
      throw new Error('Expected ink geometry.');
    }
    expect(Object.isFrozen(journaled.anchor.geometry.paths[0]?.[0])).toBe(true);
  });

  it('isolates create payloads with quadrilateral geometry', () => {
    const sourcePoint = { x: 10, y: 20 };
    const generated = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');
    const ledger = new MutationLedger(session);
    ledger.append({
      kind: 'create',
      id: generated,
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: {
          kind: 'quadrilaterals',
          quadrilaterals: [
            {
              bottomLeft: sourcePoint,
              bottomRight: { x: 20, y: 20 },
              topLeft: { x: 10, y: 10 },
              topRight: { x: 20, y: 10 },
            },
          ],
        },
      },
      color: '#ffd400',
      selectedText: 'Created highlight',
      author: '',
      createdAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      comment: '',
    });
    const captured = ledger.capture();
    sourcePoint.x = 999;

    expect(captured.mutations).toMatchObject([
      {
        kind: 'create',
        anchor: {
          geometry: { quadrilaterals: [{ bottomLeft: { x: 10, y: 20 } }] },
        },
      },
    ]);
  });

  it('refuses an invalid create type and geometry before journaling', () => {
    const invalid = {
      kind: 'create',
      id: asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08'),
      type: 'ink',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: '#ffd400',
      selectedText: null,
      author: '',
      createdAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      comment: '',
    } as unknown as AnnotationMutation;
    const ledger = new MutationLedger(session);

    expect(() => ledger.append(invalid)).toThrow(InvalidAnnotationMutationError);
    expect(ledger.pending()).toEqual([]);
    expect(ledger.state).toBe('committed');
  });

  it('refuses a forged generated id before journaling', () => {
    const invalid = {
      kind: 'create',
      id: 'not-a-uuid' as GeneratedAnnotationId,
      type: 'text-note',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: null,
      selectedText: null,
      author: '',
      createdAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      comment: '',
    } satisfies AnnotationMutation;
    const ledger = new MutationLedger(session);

    expect(() => ledger.append(invalid)).toThrow(InvalidAnnotationMutationError);
    expect(ledger.pending()).toEqual([]);
  });

  it('accepts valid fixed-page and reflowable create variants', () => {
    const ledger = new MutationLedger(session);
    const timestamp = asUtcTimestamp('2026-08-11T10:00:00.000Z');
    const generated = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');
    const common = {
      kind: 'create' as const,
      id: generated,
      color: null,
      selectedText: null,
      author: '',
      createdAt: timestamp,
      modifiedAt: timestamp,
      comment: '',
    };
    const valid: readonly AnnotationMutation[] = [
      {
        ...common,
        type: 'underline',
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'quote', prefix: '', suffix: '' },
          progression: 0.5,
        },
      },
      {
        ...common,
        type: 'ink',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'ink', paths: [[{ x: 1, y: 2 }]] },
        },
      },
      {
        ...common,
        type: 'text-note',
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'note anchor', prefix: '', suffix: '' },
          progression: null,
        },
      },
      {
        ...common,
        type: 'free-text',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: {
            kind: 'rectangle',
            rectangle: { x: 1, y: 2, width: 30, height: 40 },
          },
        },
      },
    ];

    for (const mutation of valid) ledger.append(mutation);

    expect(ledger.pending()).toHaveLength(4);
  });

  it('refuses malformed fixed and reflowable create anchors before journaling', () => {
    const timestamp = asUtcTimestamp('2026-08-11T10:00:00.000Z');
    const common = {
      kind: 'create' as const,
      id: asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08'),
      color: null,
      selectedText: null,
      author: '',
      createdAt: timestamp,
      modifiedAt: timestamp,
      comment: '',
    };
    const invalid = [
      {
        ...common,
        type: 'highlight',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'quadrilaterals', quadrilaterals: [] },
        },
      },
      {
        ...common,
        type: 'ink',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'ink', paths: [] },
        },
      },
      {
        ...common,
        type: 'free-text',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: {
            kind: 'rectangle',
            rectangle: { x: 1, y: 2, width: -1, height: 40 },
          },
        },
      },
      {
        ...common,
        type: 'text-note',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: Number.POSITIVE_INFINITY, y: 2 } },
        },
      },
      {
        ...common,
        type: 'underline',
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: '', prefix: '', suffix: '' },
          progression: 2,
        },
      },
      {
        ...common,
        type: 'text-note',
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'quote', prefix: '', suffix: '' },
          progression: 2,
        },
      },
    ] as unknown as readonly AnnotationMutation[];

    for (const mutation of invalid) {
      const ledger = new MutationLedger(session);
      expect(() => ledger.append(mutation)).toThrow(InvalidAnnotationMutationError);
      expect(ledger.pending()).toEqual([]);
    }
  });

  it('rejects unknown discriminants and malformed selector fields before journaling', () => {
    const malformed = [
      { kind: 'unknown-mutation' },
      {
        kind: 'set-comment',
        target: { kind: 'unknown-target', fingerprint: 'x', promoteTo: 'not-a-uuid' },
        comment: '',
      },
      {
        kind: 'set-geometry',
        target,
        anchor: {
          kind: 'unknown-anchor',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
          selector: { exact: 'quote', prefix: '', suffix: '' },
        },
      },
      {
        kind: 'set-geometry',
        target,
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'unknown-geometry' },
        },
      },
      {
        kind: 'set-geometry',
        target,
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'quote', prefix: 42, suffix: '' },
          progression: 0.5,
        },
      },
    ] as unknown as readonly AnnotationMutation[];

    for (const mutation of malformed) {
      const ledger = new MutationLedger(session);
      expect(() => ledger.append(mutation)).toThrow(InvalidAnnotationMutationError);
      expect(ledger.pending()).toEqual([]);
      expect(ledger.state).toBe('committed');
    }
  });

  it('rejects malformed mutation payload fields before journaling', () => {
    const timestamp = asUtcTimestamp('2026-08-11T10:00:00.000Z');
    const malformed = [
      { kind: 'set-comment', target, comment: 42 },
      { kind: 'set-color', target, color: 42 },
      { kind: 'convert-type', target, type: 'ink' },
      { kind: 'convert-type', target, type: { toString: () => 'underline' } },
      { kind: 'set-metadata', target, metadata: { author: 42, modifiedAt: timestamp } },
      {
        kind: 'set-geometry',
        target,
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: { toString: () => 'page-points-top-left' },
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
        },
      },
      {
        kind: 'create',
        id: asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08'),
        type: { toString: () => 'text-note' },
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
        },
        color: null,
        selectedText: null,
        author: '',
        createdAt: timestamp,
        modifiedAt: timestamp,
        comment: '',
      },
      {
        kind: 'create',
        id: asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08'),
        type: 'text-note',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
        },
        color: 42,
        selectedText: false,
        author: 42,
        createdAt: timestamp,
        modifiedAt: timestamp,
        comment: 42,
      },
    ] as unknown as readonly AnnotationMutation[];

    for (const mutation of malformed) {
      const ledger = new MutationLedger(session);
      expect(() => ledger.append(mutation)).toThrow(InvalidAnnotationMutationError);
      expect(ledger.pending()).toEqual([]);
    }
  });

  it('rejects coercible identity objects before journaling', () => {
    const timestamp = asUtcTimestamp('2026-08-11T10:00:00.000Z');
    const generatedObject = {
      toString: () => '01918f62-5c0b-7cc3-98ad-6f126f164f08',
    };
    const stableObject = { trim: () => 'nm-object' };
    const malformed = [
      {
        kind: 'create',
        id: generatedObject,
        type: 'text-note',
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
        },
        color: null,
        selectedText: null,
        author: '',
        createdAt: timestamp,
        modifiedAt: timestamp,
        comment: '',
      },
      {
        kind: 'set-comment',
        target: { kind: 'legacy', fingerprint: 'legacy', promoteTo: generatedObject },
        comment: '',
      },
      {
        kind: 'set-comment',
        target: { kind: 'stable', id: stableObject },
        comment: '',
      },
    ] as unknown as readonly AnnotationMutation[];

    for (const mutation of malformed) {
      const ledger = new MutationLedger(session);
      expect(() => ledger.append(mutation)).toThrow(InvalidAnnotationMutationError);
      expect(ledger.pending()).toEqual([]);
      expect(ledger.state).toBe('committed');
    }
  });

  it('isolates point, rectangle, and reflowable anchors', () => {
    const point = { x: 5, y: 6 };
    const rectangle = { x: 1, y: 2, width: 30, height: 40 };
    const selector = { exact: 'quoted text', prefix: 'before ', suffix: ' after' };
    const ledger = new MutationLedger(session);
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point },
      },
    });
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 2,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'rectangle', rectangle },
      },
    });
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: { kind: 'reflowable-text', selector, progression: 0.3 },
    });
    const captured = ledger.capture();
    point.x = 500;
    rectangle.width = 300;
    selector.exact = 'changed';

    expect(captured.mutations).toMatchObject([
      { anchor: { geometry: { point: { x: 5, y: 6 } } } },
      { anchor: { geometry: { rectangle: { width: 30, height: 40 } } } },
      { anchor: { selector: { exact: 'quoted text' }, progression: 0.3 } },
    ]);
  });

  it('isolates metadata patches from later caller changes', () => {
    const metadata = {
      author: 'Ada',
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
    };
    const ledger = new MutationLedger(session);
    ledger.append({ kind: 'set-metadata', target, metadata });
    const captured = ledger.capture();
    metadata.author = 'Changed';

    expect(captured.mutations).toEqual([
      {
        kind: 'set-metadata',
        target,
        metadata: {
          author: 'Ada',
          modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
        },
      },
    ]);
  });

  it('captures conversion and deletion targets without collapsing their identity', () => {
    const ledger = new MutationLedger(session);
    const conversion = ledger.append({
      kind: 'convert-type',
      target,
      type: 'underline',
    });
    const deletion = ledger.append({ kind: 'delete', target });

    expect(ledger.pending()).toEqual([conversion.mutation, deletion.mutation]);
    expect(ledger.pending()).toMatchObject([
      { kind: 'convert-type', target: { kind: 'stable', id: 'nm-1' }, type: 'underline' },
      { kind: 'delete', target: { kind: 'stable', id: 'nm-1' } },
    ]);
  });

  it('enforces the serialization, write, verification, commit order', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    const cause = new Error('invalid transition checks complete');

    await expect(
      runAttempt(attempt, (active, result) => {
        expect(() => {
          active.markVerifying();
        }).toThrow(/serializing/u);
        expect(() => {
          active.commit(result);
        }).toThrow(/serializing/u);
        active.markWriting();
        expect(() => {
          active.commit(result);
        }).toThrow(/writing/u);
        active.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(cause);
  });

  it('reaches committed after a fully verified generation with no later edits', async () => {
    const ledger = new MutationLedger(session);
    ledger.append(comment());
    const captured = ledger.capture();
    const attempt = ledger.prepareSave(captured);
    await runAttempt(attempt, (active, result) => {
      active.markWriting();
      active.markVerifying();
      active.commit(result);
    });

    expect(ledger.state).toBe('committed');
    expect(ledger.pending()).toEqual([]);
  });
});
