import { player } from "./player";
import { historyStore } from "./history";
import { addToHistory } from "./yt";
import { PlaybackAccumulator, PlaybackFlush } from "./playbackAccumulator";

class HistoryManager {
  private historyEnabled: boolean = true;
  private historyCleanup: "none" | "weekly" | "monthly" | "yearly" = "none";
  private currentTrackLogged: string | null = null;
  private playbackThreshold = 5000; // 5 seconds in ms
  private logTimer: any = null;
  private accumulator = new PlaybackAccumulator();
  private loggedTimestamp: number | null = null;
  private tickTimer: any = null;
  private flushCounter = 0;
  private readonly flushEverySec = 15;

  constructor() {
    this.loadSettings();
    this.init();
  }

  private loadSettings() {
    const savedEnabled = localStorage.getItem("ytm-history-enabled");
    if (savedEnabled !== null) {
      this.historyEnabled = savedEnabled === "true";
    }
    this.historyCleanup =
      (localStorage.getItem("ytm-history-cleanup") as any) || "none";
  }

  private saveSettings() {
    localStorage.setItem("ytm-history-enabled", this.historyEnabled.toString());
    localStorage.setItem("ytm-history-cleanup", this.historyCleanup);
  }

  async init() {
    await historyStore.init();

    // Subscribe to player events
    player.subscribe((event) => {
      if (event === "state") {
        this.handleStateChange();
      }
    });

    // Background cleanup every 4 hours
    this.runCleanup();
    setInterval(() => this.runCleanup(), 1000 * 60 * 60 * 4);
    // Тик раз в секунду: копим реально прослушанное время
    this.tickTimer = setInterval(() => this.onTick(), 1000);
  }

  private handleStateChange() {
    if (!this.historyEnabled || !player.currentTrack) {
        this.stopLogTimer();
        this.persistFlush(this.accumulator.setActiveTrack(null));
        return;
    }

    const currentId = player.currentTrack.id;
    // Смена активного трека: слить накопленное предыдущего в его запись
    this.persistFlush(this.accumulator.setActiveTrack(currentId));

    // If track changed, reset and start timer if playing
    if (this.currentTrackLogged !== player.currentTrack.id) {
        this.stopLogTimer();
        this.loggedTimestamp = null;

        if (player.isPlaying) {
            this.startLogTimer(player.currentTrack.id);
        }
    } else {
        // Same track, but maybe resumed/paused
        if (!player.isPlaying) {
            this.stopLogTimer();
        }
    }
  }

  private startLogTimer(trackId: string) {
    if (this.currentTrackLogged === trackId) return;
    
    this.stopLogTimer();
    this.logTimer = setTimeout(() => {
        this.logTrack(trackId);
    }, this.playbackThreshold);
  }

  private stopLogTimer() {
    if (this.logTimer) {
        clearTimeout(this.logTimer);
        this.logTimer = null;
    }
  }

  private async logTrack(trackId: string) {
    if (!player.currentTrack || player.currentTrack.id !== trackId) return;
    
    this.currentTrackLogged = trackId;
    console.log(`[history] Logging track: ${player.currentTrack.title}`);
    
    // Background YT history update — только для YT-треков (SC-id это URL, в YT-API не уходит)
    if (player.currentTrack.source !== 'soundcloud') {
      addToHistory(player.currentTrack.id).catch(err => {
        console.error("[history] YT background update failed", err);
      });
    }

    try {
      const ts = await historyStore.addEntry(player.currentTrack);
      if (ts != null) this.loggedTimestamp = ts;
    } catch (e) {
      console.error("[history] Failed to add entry", e);
    }
    
    this.logTimer = null;
  }

  private onTick() {
    if (!this.historyEnabled) return;
    this.accumulator.tick(player.isPlaying);
    this.flushCounter++;
    if (this.flushCounter >= this.flushEverySec) {
      this.flushCounter = 0;
      this.persistFlush(this.accumulator.drain());
    }
  }

  // Пишем дельту секунд в запись истории текущего залогированного трека
  private persistFlush(flush: PlaybackFlush | null) {
    if (!flush) return;
    if (this.currentTrackLogged === flush.trackId && this.loggedTimestamp != null) {
      historyStore.addListenedSeconds(this.loggedTimestamp, flush.seconds).catch(err => {
        console.error("[history] addListenedSeconds failed", err);
      });
    }
  }

  private async runCleanup() {
    if (!this.historyEnabled || this.historyCleanup === "none") return;
    console.log(`[history] Running cleanup: ${this.historyCleanup}`);
    try {
      await historyStore.cleanup(this.historyCleanup);
    } catch (e) {
      console.error("[history] Cleanup failed", e);
    }
  }

  // Settings management
  get isEnabled() {
    return this.historyEnabled;
  }
  toggleHistory() {
    this.historyEnabled = !this.historyEnabled;
    this.saveSettings();
    if (!this.historyEnabled) this.stopLogTimer();
  }

  get cleanupInterval() {
    return this.historyCleanup;
  }
  setCleanupInterval(interval: "none" | "weekly" | "monthly" | "yearly") {
    this.historyCleanup = interval;
    this.saveSettings();
    this.runCleanup();
  }
}

export const historyManager = new HistoryManager();
