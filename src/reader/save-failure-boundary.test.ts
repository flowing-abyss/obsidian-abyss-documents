import { Notice } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { SaveFailureNoticeBoundary } from './save-failure-boundary.js';

describe('SaveFailureNoticeBoundary', () => {
  it('deduplicates path/reason across views and exposes one Retry action', () => {
    const boundary = new SaveFailureNoticeBoundary();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const retryA = vi.fn();
    const retryB = vi.fn();

    const ownerA = {};
    const ownerB = {};
    const host = createDiv();
    boundary.report({
      ownerId: ownerA,
      host,
      path: 'Books/Guide.pdf',
      reason: 'disk full',
      retryAction: retryA,
    });
    boundary.report({
      ownerId: ownerB,
      host,
      path: 'Books/Guide.pdf',
      reason: 'disk full',
      retryAction: retryB,
    });

    expect(notice).toHaveBeenCalledOnce();
    const message = notice.mock.calls[0]?.[0] as DocumentFragment;
    message.querySelector<HTMLButtonElement>('button')?.click();
    expect(retryA).not.toHaveBeenCalled();
    expect(retryB).toHaveBeenCalledOnce();
    boundary.release(ownerB);
    message.querySelector<HTMLButtonElement>('button')?.click();
    expect(retryA).toHaveBeenCalledOnce();
    boundary.release(ownerA);
  });

  it('clears only the resolved owner while preserving another dirty view on the same path', () => {
    const boundary = new SaveFailureNoticeBoundary();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const owner = {};
    const host = createDiv();
    const retryA = vi.fn();
    const retryB = vi.fn();
    boundary.report({
      ownerId: owner,
      host,
      path: 'Guide.pdf',
      reason: 'disk full',
      retryAction: retryA,
    });
    const peer = {};
    boundary.report({
      ownerId: peer,
      host,
      path: 'Guide.pdf',
      reason: 'disk full',
      retryAction: retryB,
    });
    boundary.report({
      ownerId: owner,
      host,
      path: 'Other.pdf',
      reason: 'read only',
      retryAction: vi.fn(),
    });
    boundary.clear(owner, 'Guide.pdf');
    const firstMessage = notice.mock.calls[0]?.[0] as DocumentFragment;
    firstMessage.querySelector<HTMLButtonElement>('button')?.click();
    expect(retryA).not.toHaveBeenCalled();
    expect(retryB).toHaveBeenCalledOnce();
    boundary.clear(peer, 'Guide.pdf');
    boundary.report({
      ownerId: owner,
      host,
      path: 'Guide.pdf',
      reason: 'disk full',
      retryAction: vi.fn(),
    });
    expect(notice).toHaveBeenCalledTimes(3);
  });
});
