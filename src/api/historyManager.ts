import { player } from "./player";
import { historyStore } from "./history";
import { addToHistory } from "./yt";

class HistoryManager {
  private historyEnabled: boolean = true;
  private historyCleanup: "none" | "weekly" | "monthly" | "yearly" = "none";
  private currentTrackLogged: string | null = null;
  private playbackThreshold = 5000; // 5 seconds in ms
  private logTimer: any = null;

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
  }

  private handleStateChange() {
    if (!this.historyEnabled || !player.currentTrack) {
        this.stopLogTimer();
        return;
    }

    // If track changed, reset and start timer if playing
    if (this.currentTrackLogged !== player.currentTrack.id) {
        this.stopLogTimer();
        
        if (player.isPlaying) {
            this.startLogTimer(player.currentTrack.id);
        }
    } else {
        // Same track, but maybe resumed/paused
        if (!player.isPlaying) {
            this.stopLogTimer();
        } else if (!this.logTimer && this.currentTrackLogged !== player.currentTrack.id) {
            // This case shouldn't happen with current logic but for safety
            this.startLogTimer(player.currentTrack.id);
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
    
    // Background YT history update
    addToHistory(player.currentTrack.id).catch(err => {
      console.error("[history] YT background update failed", err);
    });

    try {
      await historyStore.addEntry(player.currentTrack);
    } catch (e) {
      console.error("[history] Failed to add entry", e);
    }
    
    this.logTimer = null;
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
