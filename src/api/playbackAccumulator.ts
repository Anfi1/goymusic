export interface PlaybackFlush {
  trackId: string;
  seconds: number;
}

// Чистый счётчик реально прослушанных секунд активного трека.
// Не знает про таймеры, плеер и хранилище — этим управляет historyManager.
export class PlaybackAccumulator {
  private trackId: string | null = null;
  private seconds = 0;

  setActiveTrack(trackId: string | null): PlaybackFlush | null {
    if (trackId === this.trackId) return null;
    const flush = this.flushPayload();
    this.trackId = trackId;
    this.seconds = 0;
    return flush;
  }

  tick(isPlaying: boolean): void {
    if (isPlaying && this.trackId) this.seconds++;
  }

  drain(): PlaybackFlush | null {
    const flush = this.flushPayload();
    this.seconds = 0;
    return flush;
  }

  private flushPayload(): PlaybackFlush | null {
    if (this.trackId && this.seconds > 0) {
      return { trackId: this.trackId, seconds: this.seconds };
    }
    return null;
  }
}
