import type { YTMTrack } from './yt';

export interface PendingScLikeChange {
  track: YTMTrack;
  liked: boolean;
}

export interface ScLikeQueueCallbacks {
  applyLocal: (track: YTMTrack, liked: boolean) => void | Promise<void>;
  persistRemote: (scId: string, scUrl: string, liked: boolean) => Promise<boolean>;
  onRollback: (track: YTMTrack, revertedToLiked: boolean) => void | Promise<void>;
}

interface QueueEntry {
  track: YTMTrack;
  scId: string;
  scUrl: string;
  targetLiked: boolean;
  committedLiked: boolean;
  version: number;
  inFlight: boolean;
}

export class ScLikeQueue {
  private readonly callbacks: ScLikeQueueCallbacks;
  private readonly entries = new Map<string, QueueEntry>();
  private order: string[] = [];
  private draining = false;
  private generation = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(callbacks: ScLikeQueueCallbacks) {
    this.callbacks = callbacks;
  }

  enqueue(track: YTMTrack, currentLiked: boolean, targetLiked: boolean): void {
    const scId = track.scId || track.id;
    if (!scId) return;

    const scUrl = track.scUrl || track.id;
    const existing = this.entries.get(scId);

    if (existing) {
      // Сохраняем исходный committedLiked до начала серии кликов для корректного отката или пропуска запроса
      existing.track = track;
      existing.scUrl = scUrl;
      existing.targetLiked = targetLiked;
      existing.version += 1;
      if (!existing.inFlight && !this.order.includes(scId)) {
        this.order.push(scId);
      }
    } else {
      this.entries.set(scId, {
        track,
        scId,
        scUrl,
        targetLiked,
        committedLiked: currentLiked,
        version: 1,
        inFlight: false,
      });
      this.order.push(scId);
    }

    const localResult = this.callbacks.applyLocal(track, targetLiked);
    if (localResult && typeof (localResult as Promise<void>).catch === 'function') {
      void (localResult as Promise<void>).catch(() => {});
    }

    void this.drain();
  }

  getPendingChanges(): Map<string, PendingScLikeChange> {
    const result = new Map<string, PendingScLikeChange>();
    for (const [scId, entry] of this.entries) {
      result.set(scId, { track: entry.track, liked: entry.targetLiked });
    }
    return result;
  }

  hasPending(scId?: string): boolean {
    if (scId !== undefined) {
      return this.entries.has(scId);
    }
    return this.entries.size > 0;
  }

  whenIdle(): Promise<void> {
    if (!this.draining && this.entries.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.order = [];
    this.draining = false;
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.idleResolvers.length === 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const myGen = this.generation;

    try {
      while (this.order.length > 0 && this.generation === myGen) {
        const scId = this.order.shift();
        if (!scId) continue;

        const entry = this.entries.get(scId);
        if (!entry) continue;

        if (entry.targetLiked === entry.committedLiked) {
          this.entries.delete(scId);
          continue;
        }

        const sentLiked = entry.targetLiked;
        const sentVersion = entry.version;
        const sentScUrl = entry.scUrl;
        entry.inFlight = true;

        let ok = false;
        try {
          ok = await this.callbacks.persistRemote(scId, sentScUrl, sentLiked);
        } catch {
          ok = false;
        }

        // Если очередь сбросили через clear() или запись заменилась во время запроса, устаревший ответ игнорируем
        if (this.generation !== myGen) {
          return;
        }
        if (this.entries.get(scId) !== entry) {
          continue;
        }

        entry.inFlight = false;

        if (ok) {
          entry.committedLiked = sentLiked;
          if (entry.version !== sentVersion) {
            if (entry.targetLiked !== entry.committedLiked) {
              if (!this.order.includes(scId)) {
                this.order.push(scId);
              }
            } else {
              this.entries.delete(scId);
            }
          } else {
            this.entries.delete(scId);
          }
        } else if (entry.version !== sentVersion) {
          if (entry.targetLiked !== entry.committedLiked) {
            if (!this.order.includes(scId)) {
              this.order.push(scId);
            }
          } else {
            this.entries.delete(scId);
          }
        } else {
          this.entries.delete(scId);
          try {
            await this.callbacks.onRollback(entry.track, entry.committedLiked);
          } catch {
            // Ошибка в onRollback не должна блокировать обработку оставшихся задач
          }
        }
      }
    } finally {
      if (this.generation === myGen) {
        this.draining = false;
        if (this.order.length > 0) {
          void this.drain();
        } else if (this.entries.size === 0) {
          this.resolveIdle();
        }
      }
    }
  }
}
