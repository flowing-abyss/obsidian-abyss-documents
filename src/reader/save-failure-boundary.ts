import { Notice } from 'obsidian';
import { ownerWindow } from './owner-dom.js';

export class SaveFailureNoticeBoundary {
  private readonly active = new Map<string, ActiveSaveFailureNotice>();

  report(details: {
    readonly ownerId: object;
    readonly host: HTMLElement;
    readonly path: string;
    readonly reason: string;
    readonly retryAction: () => void;
    readonly label?: string;
    readonly actionLabel?: string;
  }): void {
    const { ownerId, host, path, reason } = details;
    const key = this.key(path, reason);
    const active = this.active.get(key);
    if (active !== undefined) {
      active.owners.delete(ownerId);
      active.owners.set(ownerId, this.owner(details));
      this.refresh(active);
      return;
    }
    const owners = new Map<object, SaveFailureNoticeOwner>([[ownerId, this.owner(details)]]);
    const owner = ownerWindow(host);
    const message = owner.createFragment();
    const text = owner.createSpan();
    const retry = owner.createEl('button');
    retry.type = 'button';
    retry.onclick = () => {
      const retries = this.active.get(key)?.owners.values();
      if (retries === undefined) return;
      let latest: SaveFailureNoticeOwner | undefined;
      for (const retryOwner of retries) latest = retryOwner;
      latest?.action();
    };
    message.append(text, retry);
    const notice = new Notice(message, 0);
    const entry = { notice, owners, reason, text, action: retry };
    this.active.set(key, entry);
    this.refresh(entry);
  }

  clear(ownerId: object, path: string): void {
    const prefix = `${path}\u0000`;
    for (const [key, entry] of this.active) {
      if (!key.startsWith(prefix)) continue;
      entry.owners.delete(ownerId);
      this.deleteIfEmpty(key, entry);
    }
  }

  release(ownerId: object): void {
    for (const [key, entry] of this.active) {
      entry.owners.delete(ownerId);
      this.deleteIfEmpty(key, entry);
    }
  }

  private deleteIfEmpty(key: string, entry: ActiveSaveFailureNotice): void {
    if (entry.owners.size > 0) {
      this.refresh(entry);
      return;
    }
    entry.notice.hide();
    this.active.delete(key);
  }

  private owner(details: {
    readonly retryAction: () => void;
    readonly label?: string;
    readonly actionLabel?: string;
  }): SaveFailureNoticeOwner {
    return {
      action: details.retryAction,
      actionLabel: details.actionLabel ?? 'Retry',
      label: details.label ?? 'Could not autosave PDF annotations',
    };
  }

  private refresh(entry: ActiveSaveFailureNotice): void {
    let latest: SaveFailureNoticeOwner | undefined;
    for (const owner of entry.owners.values()) latest = owner;
    if (latest === undefined) return;
    entry.text.textContent = `${latest.label}: ${entry.reason} `;
    entry.action.textContent = latest.actionLabel;
  }

  private key(path: string, reason: string): string {
    return `${path}\u0000${reason}`;
  }
}

interface SaveFailureNoticeOwner {
  readonly action: () => void;
  readonly actionLabel: string;
  readonly label: string;
}

interface ActiveSaveFailureNotice {
  readonly notice: Notice;
  readonly owners: Map<object, SaveFailureNoticeOwner>;
  readonly reason: string;
  readonly text: HTMLSpanElement;
  readonly action: HTMLButtonElement;
}
