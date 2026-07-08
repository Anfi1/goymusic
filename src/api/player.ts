import { YTMTrack, getQueueRecommendations, rateSong, searchMore } from './yt';
import { streamCache } from './cache';
import { getStreamUrl, prefetchStreamUrl, getExpirationFromUrl, registerSoundCloudTrack } from './stream';
import { likedManager } from './likedManager';
import { deleteOverride, onOverrideChanged } from './localOverrides';
import { searchSoundCloud, isSoundCloudEnabled, interleaveTracks, pickBestScMatch, isSoundCloudId, getScRecommendations } from './soundcloud';

export type PlayerEventType = 'state' | 'tick' | 'buffer';
type PlayerCallback = (event: PlayerEventType) => void;

class PlayerStore {
    currentTrack: YTMTrack | null = null;
    queue: YTMTrack[] = [];
    queueIndex: number = -1;
    queueSourceId: string | null = null;
    queueSourceType: 'album' | 'artist' | 'playlist' | null = null;
    recommendationPlaylistId: string | null = null; 
    recommendations: YTMTrack[] = [];
    isRecommendationsLoading: boolean = false;
    isStreamLoading: boolean = false;
    hasStreamError: boolean = false;
    errorSkipCount: number = 0;
    isPlaying: boolean = false;
    currentTime: number = 0;
    duration: number = 0;
    buffered: { start: number, end: number }[] = [];
    volume: number = 80;
    private lastVolume: number = 80;
    shuffle: boolean = false;
    repeat: 'off' | 'all' | 'one' = 'off';
    autoplay: boolean = true;
    radioMode: 'youtube' | 'soundcloud' | 'hybrid' = 'youtube';
    rpcEnabled: boolean = true;
    normalizationEnabled: boolean = true;
    isCurrentTrackLocal: boolean = false;

    private audioA: HTMLAudioElement;
    private audioB: HTMLAudioElement;
    private activePlayer: 'A' | 'B' = 'A';
    private preloadedTrackId: string | null = null;
    private isPreloadingNext: boolean = false;

    private audioContext: AudioContext | null = null;
    private sourceA: MediaElementAudioSourceNode | null = null;
    private sourceB: MediaElementAudioSourceNode | null = null;
    private normalizationGain: GainNode | null = null;
    private filters: BiquadFilterNode[] = [];
    private analyzer: AnalyserNode | null = null;
    private listeners: Set<PlayerCallback> = new Set();
    private tickListeners: Set<PlayerCallback> = new Set();
    private bufferListeners: Set<PlayerCallback> = new Set();
    private updateInterval: any = null;
    private playbackId: number = 0;
    private consecutiveErrors: number = 0;

    private wtUrl: string | null = null;
    private originalQueue: YTMTrack[] = [];

    private wtCpn: string | null = null;
    private wtSessionStart: number = 0;
    private wtSegStart: number = 0;
    private wtNextFlushAt: number = 10;
    private wtPrevMediaTime: number = 0;

    // Треки, для которых уже пробовали SC-фолбэк в текущей попытке воспроизведения (защита от цикла).
    private scFallbackTried = new Set<string>();

    constructor() {
        this.audioA = new Audio();
        this.audioB = new Audio();
        this.audioA.crossOrigin = "anonymous";
        this.audioB.crossOrigin = "anonymous";
        
        this.loadState();
        this.initCache();
        this.setupEventListeners();

        // Keep UI + current playback in sync with local overrides.
        onOverrideChanged((e) => {
            // Update any UI bound to player state (e.g., PlayerBar override icon).
            this.notify('state');

            const video_id = e.detail?.videoId;
            if (e.detail?.action === 'reset') {
                if (this.currentTrack) this.startPlayback(this.currentTrack, true);
                return;
            }
            if (!video_id) return;

            // If override was toggled for the currently playing track,
            // reload its source so `src` switches between file:// and remote stream.
            if (this.currentTrack?.id === video_id) {
                this.startPlayback(this.currentTrack, true);
            }
        });
    }

    private get activeAudio() {
        return this.activePlayer === 'A' ? this.audioA : this.audioB;
    }

    private get idleAudio() {
        return this.activePlayer === 'A' ? this.audioB : this.audioA;
    }

    private async initCache() {
        try {
            await streamCache.init();
            await streamCache.clearExpired();
            setInterval(() => streamCache.clearExpired(), 1000 * 60 * 60 * 3);
        } catch (e) {
            console.error('Player cache init failed', e);
        }
    }

    async initAudioContext() {
        if (this.audioContext) {
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            return;
        }
        
        try {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.sourceA = this.audioContext.createMediaElementSource(this.audioA);
            this.sourceB = this.audioContext.createMediaElementSource(this.audioB);
            
            this.normalizationGain = this.audioContext.createGain();
            this.analyzer = this.audioContext.createAnalyser();
            this.analyzer.fftSize = 1024;
            this.analyzer.smoothingTimeConstant = 0.8;

            const freqs = [60, 250, 1000, 4000, 8000, 16000];
            const types: BiquadFilterType[] = ['lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf'];
            this.filters = freqs.map((f, i) => {
                const filter = this.audioContext!.createBiquadFilter();
                filter.type = types[i];
                filter.frequency.value = f;
                filter.Q.value = 1;
                filter.gain.value = 0;
                return filter;
            });

            this.loadEQSettings();
            this.rebuildAudioChain();
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        } catch (e) {
            console.error('Failed to init AudioContext:', e);
        }
    }

    private rebuildAudioChain() {
        if (!this.sourceA || !this.sourceB || !this.audioContext || !this.analyzer || !this.normalizationGain) return;

        this.sourceA.disconnect();
        this.sourceB.disconnect();
        this.normalizationGain.disconnect();
        this.filters.forEach(f => f.disconnect());
        this.analyzer.disconnect();

        // Connect both sources to normalization
        this.sourceA.connect(this.normalizationGain);
        this.sourceB.connect(this.normalizationGain);
        
        let lastNode: AudioNode = this.normalizationGain;

        // 2. Equalizer — skip filters near 0 dB (they don't affect sound)
        for (const f of this.filters) {
            if (Math.abs(f.gain.value) > 0.1) {
                lastNode.connect(f);
                lastNode = f;
            }
        }
        
        // 3. Analyzer
        lastNode.connect(this.analyzer);
        this.analyzer.connect(this.audioContext.destination);
    }

    private loadEQSettings() {
        try {
            const saved = localStorage.getItem('ytm-eq-presets');
            const activeName = localStorage.getItem('ytm-eq-active') || 'Flat';
            if (saved) {
                const presets = JSON.parse(saved);
                const active = presets.find((p: any) => p.name === activeName) || presets[0];
                if (active && this.filters && this.filters.length > 0) {
                    active.bands.forEach((b: any, i: number) => {
                        if (this.filters[i]) {
                            this.filters[i].gain.value = b.gain;
                            this.filters[i].frequency.value = b.frequency;
                            if (b.type) {
                                this.filters[i].type = b.type;
                            }
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load EQ settings', e);
        }
    }

    setBand(index: number, gain: number, freq?: number, type?: BiquadFilterType, Q?: number) {
        this.initAudioContext();
        if (this.filters[index]) {
            this.filters[index].gain.value = gain;
            if (freq !== undefined) this.filters[index].frequency.value = freq;
            if (type !== undefined) {
                this.filters[index].type = type;
            }
            if (Q !== undefined) {
                this.filters[index].Q.value = Q;
            }
            this.rebuildAudioChain();
            this.notify('state');
        }
    }

    getEQBands() {
        if (this.filters.length === 0) return [];
        return this.filters.map(f => ({
            gain: f.gain.value,
            frequency: f.frequency.value,
            type: f.type,
            Q: f.Q.value
        }));
    }

    /** Add a new peaking band at the given frequency/gain. */
    addBand(frequency: number, gain: number) {
        this.initAudioContext();
        const filter = this.audioContext!.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = Math.max(20, Math.min(20000, frequency));
        filter.Q.value = 1;
        filter.gain.value = gain;
        this.filters.push(filter);
        this.rebuildAudioChain();
        this.notify('state');
    }

    /** Remove a band by index. */
    removeBand(index: number) {
        if (index < 0 || index >= this.filters.length) return;
        this.filters[index].disconnect();
        this.filters.splice(index, 1);
        this.rebuildAudioChain();
        this.notify('state');
    }

    getAnalyzerData() {
        if (!this.analyzer || !this.audioContext || this.audioContext.state !== 'running') return new Uint8Array(0);
        const data = new Uint8Array(this.analyzer.frequencyBinCount);
        this.analyzer.getByteFrequencyData(data);
        return data;
    }

    /** Half of the audio context sample rate (Hz) — upper frequency the FFT covers. */
    getAnalyzerSampleRate(): number {
        if (!this.audioContext) return 44100;
        return this.audioContext.sampleRate;
    }

    /** Time-domain (oscilloscope) samples, 0–255 with 128 as the zero line. */
    getWaveformData() {
        if (!this.analyzer || !this.audioContext || this.audioContext.state !== 'running') return new Uint8Array(0);
        const data = new Uint8Array(this.analyzer.fftSize);
        this.analyzer.getByteTimeDomainData(data);
        return data;
    }

    private loadState() {
        try {
            const savedVolume = localStorage.getItem('ytm-volume');
            if (savedVolume !== null) {
                this.volume = parseInt(savedVolume, 10);
                this.audioA.volume = this.volume / 100;
                this.audioB.volume = this.volume / 100;
            }

            const savedShuffle = localStorage.getItem('ytm-shuffle');
            if (savedShuffle !== null) {
                this.shuffle = savedShuffle === 'true';
            }

            const savedRepeat = localStorage.getItem('ytm-repeat');
            if (savedRepeat !== null) {
                this.repeat = savedRepeat as any;
            }

            const savedAutoplay = localStorage.getItem('ytm-autoplay');
            if (savedAutoplay !== null) {
                this.autoplay = savedAutoplay === 'true';
            }

            const savedRadioMode = localStorage.getItem('ytm-radio-mode');
            if (savedRadioMode === 'youtube' || savedRadioMode === 'soundcloud' || savedRadioMode === 'hybrid') {
                this.radioMode = savedRadioMode;
            }

            const savedRPC = localStorage.getItem('ytm-rpc-enabled');
            if (savedRPC !== null) {
                this.rpcEnabled = savedRPC === 'true';
            }

            const savedNormalization = localStorage.getItem('ytm-normalization-enabled');
            if (savedNormalization !== null) {
                this.normalizationEnabled = savedNormalization === 'true';
            }

            this.queueSourceId = localStorage.getItem('ytm-queue-source');
            this.queueSourceType = localStorage.getItem('ytm-queue-source-type') as any;
            this.recommendationPlaylistId = localStorage.getItem('ytm-recommendation-id');

            const savedTrack = localStorage.getItem('ytm-last-track');
            if (savedTrack) {
                this.currentTrack = JSON.parse(savedTrack);
                this.duration = this.parseDuration(this.currentTrack?.duration || '0:00');
                if (this.currentTrack) this.fetchRecommendations(this.currentTrack.id);
            }

            const savedQueue = localStorage.getItem('ytm-queue');
            if (savedQueue) {
                this.queue = JSON.parse(savedQueue);
            }

            const savedQueueIndex = localStorage.getItem('ytm-queue-index');
            if (savedQueueIndex !== null) {
                this.queueIndex = parseInt(savedQueueIndex, 10);
            }

            if (this.shuffle) {
                const savedOriginalQueue = localStorage.getItem('ytm-original-queue');
                this.originalQueue = savedOriginalQueue ? JSON.parse(savedOriginalQueue) : [...this.queue];
            }
        } catch (e) {
            console.error('Failed to load player state:', e);
        }
    }

    private saveStateTimer: any = null;
    private saveState() {
        if (this.saveStateTimer) clearTimeout(this.saveStateTimer);
        this.saveStateTimer = setTimeout(() => {
            try {
                localStorage.setItem('ytm-volume', this.volume.toString());
                localStorage.setItem('ytm-shuffle', this.shuffle.toString());
                localStorage.setItem('ytm-repeat', this.repeat);
                localStorage.setItem('ytm-autoplay', this.autoplay.toString());
                localStorage.setItem('ytm-radio-mode', this.radioMode);
                localStorage.setItem('ytm-rpc-enabled', this.rpcEnabled.toString());
                localStorage.setItem('ytm-normalization-enabled', this.normalizationEnabled.toString());
                localStorage.setItem('ytm-queue-source', this.queueSourceId || '');
                localStorage.setItem('ytm-queue-source-type', this.queueSourceType || '');
                localStorage.setItem('ytm-recommendation-id', this.recommendationPlaylistId || '');
                if (this.currentTrack) {
                    localStorage.setItem('ytm-last-track', JSON.stringify(this.currentTrack));
                }
                
                // Limit queue size saved to local storage to avoid quota limits and stringify UI locks
                const queueToSave = this.queue.length > 500 ? this.queue.slice(0, 500) : this.queue;
                localStorage.setItem('ytm-queue', JSON.stringify(queueToSave));
                localStorage.setItem('ytm-queue-index', this.queueIndex.toString());
                if (this.shuffle && this.originalQueue.length > 0) {
                    const origToSave = this.originalQueue.length > 500 ? this.originalQueue.slice(0, 500) : this.originalQueue;
                    localStorage.setItem('ytm-original-queue', JSON.stringify(origToSave));
                } else {
                    localStorage.removeItem('ytm-original-queue');
                }
            } catch (e) {
                console.error('Failed to save player state:', e);
            }
        }, 1000);
    }

    subscribe(cb: PlayerCallback, options: { tick?: boolean, buffer?: boolean } = {}): () => void {
        this.listeners.add(cb);
        if (options.tick) this.tickListeners.add(cb);
        if (options.buffer) this.bufferListeners.add(cb);
        return () => { 
            this.listeners.delete(cb); 
            this.tickListeners.delete(cb);
            this.bufferListeners.delete(cb);
        };
    }

    private notify(event: PlayerEventType = 'state') {
        if (event === 'state') {
            this.updateRPC();
            this.listeners.forEach(cb => cb(event));
        } else if (event === 'tick') {
            this.tickListeners.forEach(cb => cb(event));
        } else if (event === 'buffer') {
            this.bufferListeners.forEach(cb => cb(event));
        }
    }

    private lastRPCStatus: string = "";
    private updateRPC(force: boolean = false) {
        if (!this.rpcEnabled || !this.currentTrack || !this.isPlaying) {
            if (this.lastRPCStatus !== "cleared") {
                window.bridge.clearRPC();
                this.lastRPCStatus = "cleared";
            }
            return;
        }
        
        const statusKey = `${this.currentTrack.id}-${this.isPlaying}-${this.duration}`;
        if (!force && statusKey === this.lastRPCStatus) return;
        this.lastRPCStatus = statusKey;

        window.bridge.setRPC({
            title: this.currentTrack.title,
            artist: this.currentTrack.artists?.join(', ') || 'Unknown Artist',
            isPlaying: this.isPlaying,
            thumbUrl: this.currentTrack.thumbUrl,
            duration: this.duration,
            currentTime: this.currentTime
        });
    }

    toggleRPC() {
        this.rpcEnabled = !this.rpcEnabled;
        this.saveState();
        this.updateRPC(true);
        this.notify('state');
    }

    toggleNormalization() {
        this.normalizationEnabled = !this.normalizationEnabled;
        this.saveState();
        this.applyNormalization(this.currentLoudness);
        this.notify('state');
    }

    private currentLoudness: number = 0;
    private applyNormalization(loudness: number) {
        this.currentLoudness = loudness;
        if (!this.normalizationGain || !this.audioContext) return;

        let gainValue = 1.0;
        if (this.normalizationEnabled && loudness !== 0) {
            const targetGain = Math.pow(10, -loudness / 20);
            gainValue = Math.min(targetGain, 2.0); 
            
            console.log(
                `%c[player] Normalization applied: ${loudness}dB -> Gain: ${gainValue.toFixed(3)}`, 
                'color: #4CAF50; font-weight: bold;'
            );
        } else {
            console.log(
                `%c[player] Normalization: ${this.normalizationEnabled ? 'Zero loudness (default)' : 'Disabled by user'}. Gain set to 1.0.`, 
                'color: #888;'
            );
        }

        const now = this.audioContext.currentTime;
        this.normalizationGain.gain.cancelScheduledValues(now);
        this.normalizationGain.gain.linearRampToValueAtTime(gainValue, now + 0.5);
    }

    private lastBufferNotify: number = 0;
    private setupEventListeners() {
        [this.audioA, this.audioB].forEach((audio, idx) => {
            const playerLabel = idx === 0 ? 'A' : 'B';
            
            audio.addEventListener('play', () => {
                if (this.activePlayer !== playerLabel) return;
                this.isPlaying = true;
                if (this.audioContext?.state === 'suspended') this.audioContext.resume();
                this.startTimer();
                this.notify('state');
            });

            audio.addEventListener('pause', () => {
                if (this.activePlayer !== playerLabel) return;
                if (this.isStreamLoading) return;
                this.isPlaying = false;
                this.stopTimer();
                this.notify('state');
            });

            audio.addEventListener('ended', () => {
                if (this.activePlayer !== playerLabel) return;
                console.log(`[player] Player ${playerLabel} ended`);
                this.wtFlush('ended');
                this.wtUrl = null;
                if (this.repeat === 'one') {
                    audio.currentTime = 0;
                    audio.play();
                } else {
                    this.next();
                }
            });

            audio.addEventListener('durationchange', () => {
                if (this.activePlayer !== playerLabel) return;
                if (audio.src && isFinite(audio.duration) && audio.duration > 0) {
                    if (this.duration !== audio.duration) {
                        this.duration = audio.duration;
                        this.notify('state');
                    }
                }
            });

            audio.addEventListener('progress', () => {
                if (this.activePlayer !== playerLabel) return;
                
                const now = Date.now();
                if (now - this.lastBufferNotify < 1000) return; // Throttle to 1s
                this.lastBufferNotify = now;

                if (audio.duration > 0 && isFinite(audio.duration)) {
                    const ranges = [];
                    for (let i = 0; i < audio.buffered.length; i++) {
                        ranges.push({
                            start: (audio.buffered.start(i) / audio.duration) * 100,
                            end: (audio.buffered.end(i) / audio.duration) * 100
                        });
                    }
                    this.buffered = ranges;
                    this.notify('buffer'); // Only notify buffer listeners
                }
            });

            audio.addEventListener('error', (e) => {
                if (this.activePlayer !== playerLabel) return;
                console.error(`Audio player ${playerLabel} error:`, e);
                // During loading, onMediaError in startPlayback handles the error.
                // Only intervene for mid-playback errors (after stream loaded).
                if (!this.isStreamLoading) {
                    this.isPlaying = false;
                    this.notify('state');
                }
            });
        });

        if (typeof window !== 'undefined') {
            window.addEventListener('track-like-updated', ((e: CustomEvent) => {
                if (e.detail.status === 'success') {
                    const { id, likeStatus } = e.detail;
                    let changed = false;
                    
                    if (this.currentTrack?.id === id && this.currentTrack?.likeStatus !== likeStatus) {
                        this.currentTrack!.likeStatus = likeStatus;
                        changed = true;
                    }
                    
                    for (const track of this.queue) {
                        if (track.id === id && track.likeStatus !== likeStatus) {
                            track.likeStatus = likeStatus;
                            changed = true;
                        }
                    }
                    
                    for (const track of this.recommendations) {
                        if (track.id === id && track.likeStatus !== likeStatus) {
                            track.likeStatus = likeStatus;
                            changed = true;
                        }
                    }
                    
                    if (changed) {
                        this.saveState();
                        this.notify('state');
                    }
                }
            }) as EventListener);
        }
    }

    private initWatchtime(url: string) {
        const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
        this.wtUrl = url;
        this.wtCpn = Array.from({length: 16}, () => a[Math.floor(Math.random() * 64)]).join('');
        this.wtSessionStart = Date.now();
        this.wtSegStart = 0;
        this.wtNextFlushAt = 10;
        this.wtPrevMediaTime = 0;
    }

    private wtAdvanceSchedule() {
        const next = [10, 20, 30].find(t => t > this.wtNextFlushAt);
        this.wtNextFlushAt = next ?? (this.wtNextFlushAt + 40);
    }

    private wtFlush(state: 'playing' | 'paused' | 'ended') {
        if (!this.wtUrl || !this.wtCpn) return;
        const cmt = this.currentTime;
        const st = this.wtSegStart;
        const rt = (Date.now() - this.wtSessionStart) / 1000;
        this.wtSegStart = cmt;
        this.wtAdvanceSchedule();
        (window as any).bridge.pyCall('send_watchtime', {
            watchtimeUrl: this.wtUrl,
            cpn: this.wtCpn,
            cmt: Math.round(cmt * 1000) / 1000,
            st: st.toFixed(3),
            et: cmt.toFixed(3),
            state,
            len: Math.round(this.duration),
            rt: Math.round(rt * 1000) / 1000,
            lact: Math.round(rt * 1000),
            callId: Math.random().toString(36).slice(2),
        }).catch(() => {});
    }

    private startTimer() {
        this.stopTimer();
        const active = this.activeAudio;
        if (!active.src || active.paused) return;

        this.updateInterval = setInterval(() => {
            if (active.src && !active.paused) {
                this.currentTime = active.currentTime;
                if (this.duration > 0 && (this.duration - this.currentTime) <= 5) {
                    this.preloadNextTrack();
                }
                if (this.wtUrl) {
                    const diff = this.currentTime - this.wtPrevMediaTime;
                    if (diff > 2 || diff < -0.1) {
                        while (this.wtNextFlushAt <= this.currentTime) this.wtAdvanceSchedule();
                        this.wtSegStart = this.currentTime;
                    }
                    this.wtPrevMediaTime = this.currentTime;
                    if (this.currentTime >= this.wtNextFlushAt) this.wtFlush('playing');
                }
                this.notify('tick');
            } else {
                this.stopTimer();
            }
        }, 600); // 600ms interval for better efficiency
    }

    // Регистрируем SC-трек в реестре стримов до префетча, иначе prefetchStreamUrl уйдёт
    // в YouTube-путь и предзагрузка SC-трека не сработает (бесшовность пропадёт).
    private ensureScRegistered(track?: YTMTrack | null) {
        if (track?.source === 'soundcloud' && track.scUrl) registerSoundCloudTrack(track.id, track.scUrl);
    }

    private async preloadNextTrack() {
        if (this.isPreloadingNext || this.preloadedTrackId || this.shuffle || this.repeat === 'one') return;

        const nextTrack = this.getNextTrackInQueue();
        if (!nextTrack || nextTrack.id === this.currentTrack?.id) return;

        this.isPreloadingNext = true;
        try {
            this.ensureScRegistered(nextTrack);
            let entry = await streamCache.get(nextTrack.id);
            if (!entry) {
                await prefetchStreamUrl(nextTrack.id);
                entry = await streamCache.get(nextTrack.id);
            }
            if (entry) {
                const idle = this.idleAudio;
                idle.src = entry.url;
                idle.load();
                this.preloadedTrackId = nextTrack.id;
            }
        } catch (e) {
            console.error('[player] Preload failed', e);
        } finally {
            this.isPreloadingNext = false;
        }
    }

    private getNextTrackInQueue(): YTMTrack | null {
        if (this.queueIndex + 1 < this.queue.length) {
            return this.queue[this.queueIndex + 1];
        }
        if (this.autoplay && this.recommendations.length > 0) {
            return this.recommendations[0];
        }
        if (this.repeat === 'all' && this.queue.length > 0) {
            return this.queue[0];
        }
        return null;
    }

    private stopTimer() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    private resolveContextId(track: YTMTrack, recId: string | null, sourceId: string | null): string | null {
        if (recId && !recId.startsWith('MPREb') && recId !== 'LM') return recId;
        const candidates = [track.audioPlaylistId, track.playlistId, sourceId];
        for (const id of candidates) {
            if (id && !id.startsWith('MPREb') && id !== 'LM') return id;
        }
        if (sourceId?.startsWith('MPREb') && track.audioPlaylistId) return track.audioPlaylistId;
        return null;
    }

    async playTrackList(tracks: YTMTrack[], startIndex: number = 0, sourceId: string | null = null, sourceType?: 'album' | 'artist' | 'playlist', recommendationId: string | null = null) {
        const targetTrack = tracks[startIndex];
        if (targetTrack && targetTrack.isAvailable === false) return;
        const availableTracks = tracks.filter(t => t.isAvailable !== false);
        const newIndex = availableTracks.findIndex(t => t.id === targetTrack?.id);
        if (newIndex !== -1) {
            this.queueSourceId = sourceId;
            this.queueSourceType = sourceType || this.detectSourceType(sourceId);
            this.recommendationPlaylistId = this.resolveContextId(targetTrack, recommendationId, sourceId);
            this.recommendations = [];
            this.errorSkipCount = 0;
            this.consecutiveErrors = 0;
            if (this.shuffle) {
                this.originalQueue = [...availableTracks];
                this.queue = [...availableTracks];
                for (let i = this.queue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
                }
                // move selected track to front
                const si = this.queue.findIndex(t => t.id === targetTrack.id);
                if (si > 0) [this.queue[0], this.queue[si]] = [this.queue[si], this.queue[0]];
                this.queueIndex = 0;
            } else {
                this.queue = availableTracks;
                this.queueIndex = newIndex;
            }
            await this.playCurrentTrack();
        }
    }

    private detectSourceType(id: string | null): any {
        if (!id) return null;
        if (id.startsWith('MPREb') || id.startsWith('OLAK')) return 'album';
        if (id.startsWith('UC') || id.startsWith('Fv')) return 'artist';
        if (id.startsWith('PL') || id.startsWith('RD') || id.startsWith('VL')) return 'playlist';
        return null;
    }

    updateQueueIfSourceMatches(sourceId: string, newTracks: YTMTrack[]) {
        if (this.queueSourceId === sourceId) {
            const availableTracks = newTracks.filter(t => t.isAvailable !== false);
            
            // Avoid unnecessary updates if queue is identical
            if (this.queue.length === availableTracks.length) {
                const isIdentical = this.queue.every((t, i) => t.id === availableTracks[i].id && t.likeStatus === availableTracks[i].likeStatus);
                if (isIdentical) return;
            }

            if (this.shuffle) {
                // Update originalQueue and patch track data in shuffled queue without reordering
                this.originalQueue = availableTracks;
                // Preserve in-memory likeStatus — API data may be stale
                this.queue = this.queue.map(t => {
                    const fresh = availableTracks.find(u => u.id === t.id);
                    return fresh ? { ...fresh, likeStatus: t.likeStatus ?? fresh.likeStatus } : t;
                });
                // queueIndex stays — it refers to position in the shuffled queue
            } else {
                if (this.currentTrack) {
                    const newIndex = availableTracks.findIndex(t => t.id === this.currentTrack?.id);
                    if (newIndex !== -1) this.queueIndex = newIndex;
                }
                // Preserve in-memory likeStatus — API data may be stale
                const prevQueue = this.queue;
                this.queue = availableTracks.map(t => {
                    const existing = prevQueue.find(u => u.id === t.id);
                    return existing ? { ...t, likeStatus: existing.likeStatus ?? t.likeStatus } : t;
                });
            }
            // Keep currentTrack reference in sync with queue object
            if (this.currentTrack && this.queueIndex >= 0 && this.queue[this.queueIndex]?.id === this.currentTrack.id) {
                this.currentTrack = this.queue[this.queueIndex];
            }
            this.saveState();
            this.notify('state');
        }
    }

    addToQueue(track: YTMTrack) {
        if (track.isAvailable === false) return;
        this.queue = [...this.queue, track];
        if (this.shuffle) this.originalQueue = [...this.originalQueue, track];
        this.recommendations = this.recommendations.filter(t => t.id !== track.id);
        this.saveState();
        this.notify('state');
    }

    removeFromQueue(index: number) {
        if (index < 0 || index >= this.queue.length) return;
        const removedId = this.queue[index].id;
        const newQueue = [...this.queue];
        newQueue.splice(index, 1);
        if (this.shuffle) this.originalQueue = this.originalQueue.filter(t => t.id !== removedId);
        if (index === this.queueIndex) {
            this.queue = newQueue;
            this.next();
        } else {
            if (index < this.queueIndex) this.queueIndex--;
            this.queue = newQueue;
            this.saveState();
            this.notify('state');
        }
    }

    moveInQueue(fromIndex: number, toIndex: number) {
        if (fromIndex < 0 || fromIndex >= this.queue.length || toIndex < 0 || toIndex >= this.queue.length || fromIndex === toIndex) return;
        const newQueue = [...this.queue];
        const track = newQueue[fromIndex];
        newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, track);
        let newQueueIndex = this.queueIndex;
        if (this.queueIndex === fromIndex) newQueueIndex = toIndex;
        else {
            if (fromIndex < this.queueIndex && toIndex >= this.queueIndex) newQueueIndex--;
            else if (fromIndex > this.queueIndex && toIndex <= this.queueIndex) newQueueIndex++;
        }
        this.queue = newQueue;
        this.queueIndex = newQueueIndex;
        this.saveState();
        this.notify('state');
    }

    playNext(track: YTMTrack) {
        if (track.isAvailable === false) return;
        if (this.queue.length === 0) this.playTrackList([track], 0);
        else {
            const newQueue = [...this.queue];
            newQueue.splice(this.queueIndex + 1, 0, track);
            this.queue = newQueue;
            if (this.shuffle) this.originalQueue = [...this.originalQueue, track];
            this.recommendations = this.recommendations.filter(t => t.id !== track.id);
            this.saveState();
            this.notify('state');
        }
    }

    async playSingle(track: YTMTrack, sourceId: string | null = null, sourceType?: 'album' | 'artist' | 'playlist', recommendationId: string | null = null) {
        if (track.isAvailable === false) return;
        this.queueSourceId = sourceId;
        this.queueSourceType = sourceType || this.detectSourceType(sourceId);
        this.recommendationPlaylistId = this.resolveContextId(track, recommendationId, sourceId);
        this.currentTrack = track;
        this.queue = [track];
        this.originalQueue = [track];
        this.queueIndex = 0;
        this.recommendations = [];
        this.errorSkipCount = 0;
        this.consecutiveErrors = 0;
        await this.startPlayback(track);
    }

    async addToQueueAndPlay(track: YTMTrack) {
        if (track.isAvailable === false) return;
        const existingIndex = this.queue.findIndex(t => t.id === track.id);
        if (existingIndex !== -1) {
            this.queueIndex = existingIndex;
        } else {
            this.queue = [...this.queue, track];
            this.queueIndex = this.queue.length - 1;
        }
        this.recommendations = this.recommendations.filter(t => t.id !== track.id);
        await this.playCurrentTrack();
    }

    async addRecommendationsAndPlay(track: YTMTrack) {
        if (track.isAvailable === false) return;
        
        const trackIdx = this.recommendations.findIndex(t => t.id === track.id);
        if (trackIdx === -1) {
            await this.addToQueueAndPlay(track);
            return;
        }

        const toAdd = this.recommendations.slice(0, trackIdx + 1);
        const remaining = this.recommendations.slice(trackIdx + 1);

        this.queue = [...this.queue, ...toAdd];
        this.queueIndex = this.queue.length - 1; 
        this.recommendations = remaining;
        
        this.saveState();
        await this.playCurrentTrack();
    }

    private async playCurrentTrack() {
        if (this.queueIndex < 0 || this.queueIndex >= this.queue.length) return;
        this.currentTrack = this.queue[this.queueIndex];
        await this.startPlayback(this.currentTrack);
    }

    private async prefetchBuffer() {
        const index = this.queueIndex;
        if (index < 0) return;
        const targets: (YTMTrack | undefined)[] = [];
        if (index + 1 < this.queue.length) targets.push(this.queue[index + 1]);
        else if (this.autoplay && this.recommendations.length > 0) targets.push(this.recommendations[0]);
        if (index > 0) targets.push(this.queue[index - 1]);
        if (index + 2 < this.queue.length) targets.push(this.queue[index + 2]);
        for (const t of targets) {
            if (!t?.id) continue;
            this.ensureScRegistered(t);
            await prefetchStreamUrl(t.id);
        }
    }

    private async startPlayback(track: YTMTrack, isRetry: boolean = false, startTime: number = 0) {
        const currentPlaybackId = ++this.playbackId;

        // Свежий (не ретрай) запуск трека снова даёт право на SC-фолбэк.
        if (!isRetry) this.scFallbackTried.delete(track.id);

        this.isStreamLoading = true;
        this.hasStreamError = false;
        this.isPlaying = true;

        this.stopTimer();
        this.audioA.pause();
        this.audioB.pause();
        this.audioA.removeAttribute('src');
        this.audioB.removeAttribute('src');
        this.audioA.load();
        this.audioB.load();

        this.activePlayer = 'A';
        this.preloadedTrackId = null;
        this.isPreloadingNext = false;
        this.isCurrentTrackLocal = false;

        await this.initAudioContext();
        this.currentTime = startTime;
        this.duration = this.parseDuration(track.duration);
        this.buffered = [];
        this.wtFlush('paused');
        this.wtUrl = null;
        this.saveState();
        this.notify('state'); 
        
        if (this.recommendations.length < 5 && !this.isRecommendationsLoading) {
            this.fetchRecommendations(track.id);
        }

        try {
            // Гарантируем маршрутизацию SC-стрима даже для треков из восстановленной очереди
            if (track.source === 'soundcloud' && track.scUrl) {
                registerSoundCloudTrack(track.id, track.scUrl);
            }
            const entry = await getStreamUrl(track.id, isRetry);
            
            if (currentPlaybackId !== this.playbackId) return;

            if (entry) {
                this.isCurrentTrackLocal = entry.url.startsWith('file:///');
                this.audioA.src = entry.url;
                this.audioA.volume = this.volume / 100;
                this.audioB.volume = this.volume / 100;

                this.applyNormalization(entry.loudness || 0);

                const onMediaError = async () => {
                    this.audioA.removeEventListener('error', onMediaError);
                    this.audioA.removeEventListener('canplay', onCanPlay);
                    if (currentPlaybackId !== this.playbackId) return;
                    if (this.isCurrentTrackLocal) {
                        // File missing — remove override and retry with YTM stream
                        this.isCurrentTrackLocal = false;
                        await deleteOverride(track.id);
                        this.startPlayback(track, true, startTime);
                        return;
                    }
                    if (!isRetry) this.startPlayback(track, true, startTime);
                    else if (!(await this.tryScFallback(track, startTime))) this.handleFinalError();
                };

                const onCanPlay = async () => {
                    this.audioA.removeEventListener('canplay', onCanPlay);
                    this.audioA.removeEventListener('error', onMediaError);
                    if (currentPlaybackId !== this.playbackId) return;
                    this.isStreamLoading = false;
                    this.consecutiveErrors = 0;
                    this.errorSkipCount = 0;
                    console.log(`[watchtime] onCanPlay: isPlaying=${this.isPlaying} watchtimeUrl=${entry.watchtimeUrl ? 'YES' : 'NO'}`);
                    if (!this.isPlaying) { this.notify('state'); return; }
                    try {
                        if (this.audioContext?.state === 'suspended') await this.audioContext.resume();
                        if (startTime > 0) {
                            this.audioA.currentTime = startTime;
                            this.currentTime = startTime;
                        }
                        await this.audioA.play();
                        if (entry.watchtimeUrl) this.initWatchtime(entry.watchtimeUrl);
                        this.prefetchBuffer();
                    } catch (e: any) {
                        if (e.name === 'NotSupportedError' && this.isPlaying) this.next();
                    }
                };
                
                this.audioA.addEventListener('error', onMediaError);
                this.audioA.addEventListener('canplay', onCanPlay);
            } else {
                if (!isRetry) this.startPlayback(track, true, startTime);
                else if (!(await this.tryScFallback(track, startTime))) this.handleFinalError();
            }
        } catch (e) {
            if (currentPlaybackId === this.playbackId) {
                if (!isRetry) this.startPlayback(track, true, startTime);
                else if (!(await this.tryScFallback(track, startTime))) this.handleFinalError();
            }
        }
    }

    /**
     * YT-стрим не доступен → ищем трек в SoundCloud по «artist title», матчим по длительности
     * и играем из SC, регистрируя SC-URL на исходный track.id. Возвращает true, если фолбэк запущен.
     */
    private async tryScFallback(track: YTMTrack, startTime: number): Promise<boolean> {
        if (!isSoundCloudEnabled() || track.source === 'soundcloud') return false;
        if (this.scFallbackTried.has(track.id)) return false;
        this.scFallbackTried.add(track.id);

        const query = [track.artists?.[0], track.title].filter(Boolean).join(' ').trim();
        if (!query) return false;
        console.log(`[player] YT unavailable for ${track.id}, trying SoundCloud fallback: "${query}"`);

        const results = await searchSoundCloud(query);
        const match = pickBestScMatch(results, this.parseDuration(track.duration));
        if (!match?.scUrl) {
            console.warn(`[player] SoundCloud fallback found no match for "${query}"`);
            return false;
        }

        registerSoundCloudTrack(track.id, match.scUrl);
        track.scUrl = match.scUrl;
        track.source = 'soundcloud';
        if (this.currentTrack?.id === track.id) this.currentTrack = { ...track };
        const qi = this.queue.findIndex(t => t.id === track.id);
        if (qi !== -1) this.queue[qi] = { ...this.queue[qi], scUrl: match.scUrl, source: 'soundcloud' };
        this.notify('state');
        this.saveState();

        // isRetry=true: не сбрасываем scFallbackTried, чтобы при провале и SC не зациклиться.
        await this.startPlayback(this.currentTrack ?? track, true, startTime);
        return true;
    }

    private handleFinalError() {
        this.isStreamLoading = false;
        if (!this.isPlaying) {
            this.hasStreamError = true;
            this.notify('state');
            return;
        }
        this.consecutiveErrors++;
        this.errorSkipCount++;
        if (this.consecutiveErrors >= 3) {
            this.consecutiveErrors = 0;
            this.isPlaying = false;
            this.hasStreamError = true;
            this.notify('state');
        } else {
            this.notify('state');
            this.next(true);
        }
    }

    async startRadio(track: YTMTrack) {
        if (track.isAvailable === false) return;
        this.queueSourceId = null;
        this.queueSourceType = null;
        // Для SC-трека YT-плейлист RDAMVM невалиден — радио пойдёт через SC (fetchRecommendations).
        this.recommendationPlaylistId = track.source === 'soundcloud' ? null : 'RDAMVM' + track.id;
        this.currentTrack = track;
        this.queue = [track];
        this.originalQueue = [track];
        this.queueIndex = 0;
        this.recommendations = [];
        this.notify('state');
        await this.startPlayback(track);
        await this.fetchRecommendations(track.id, true);
    }

    async refreshRecommendations() {
        if (!this.currentTrack || this.isRecommendationsLoading) return;
        await this.fetchRecommendations(this.currentTrack.id, true);
    }

    private async fetchRecommendations(videoId: string, forceReplace = false) {
        if (this.isRecommendationsLoading) return;
        this.isRecommendationsLoading = true;
        this.notify('state');
        try {
            // При выключенном SoundCloud режим = youtube. НО от SC-трека YT-радио построить нельзя
            // (нет YT videoId — RDAMVM+<sc-url> невалиден), поэтому для SC-трека всегда SC-радио.
            const seedTrack = (this.currentTrack?.id === videoId) ? this.currentTrack : this.queue.find(t => t.id === videoId);
            const seedIsSc = seedTrack?.source === 'soundcloud' || isSoundCloudId(videoId);
            // SC-сид: в режиме «Гибрид» добираем YouTube через матч (как E3, но обратно); иначе SC-радио.
            const mode = seedIsSc
                ? (isSoundCloudEnabled() && this.radioMode === 'hybrid' ? 'hybrid' : 'soundcloud')
                : (isSoundCloudEnabled() ? this.radioMode : 'youtube');
            if (mode === 'soundcloud') await this.fetchSoundCloudRadio(videoId, forceReplace);
            else if (mode === 'hybrid') await this.fetchHybridRecommendations(videoId, forceReplace);
            else await this.fetchYouTubeRecommendations(videoId, forceReplace);
        } catch (e) { console.error('[player] Failed to fetch recommendations:', e); }
        finally {
            this.isRecommendationsLoading = false;
            this.notify('state');
        }
    }


    // YT-логика без изменений. Seeding альбома/плейлиста/RD работает только в этом режиме.
    private async fetchYouTubeRecommendations(videoId: string, forceReplace: boolean) {
        const track = (this.currentTrack?.id === videoId) ? this.currentTrack : this.queue.find(t => t.id === videoId);
        const rid = track ? this.resolveContextId(track, this.recommendationPlaylistId, this.queueSourceId) : (this.recommendationPlaylistId || this.queueSourceId);
        const { tracks } = await getQueueRecommendations(videoId, rid);
        if (tracks.length > 0) {
            const qIds = new Set(this.queue.map(t => t.id));
            if (this.queue.length <= 1 && rid && (rid.startsWith('OLAK') || rid.startsWith('PL') || rid.startsWith('RD'))) {
                const currentIndex = tracks.findIndex(t => t.id === videoId);
                if (currentIndex !== -1) {
                    // Preserve in-memory likeStatus so the API response doesn't overwrite user-toggled state
                    const currentTrackItem = { ...tracks[currentIndex], likeStatus: this.currentTrack?.likeStatus ?? tracks[currentIndex].likeStatus };
                    const otherTracks = tracks.filter(t => t.id !== videoId);
                    this.queue = [currentTrackItem, ...otherTracks];
                    this.queueIndex = 0;
                    this.currentTrack = this.queue[0];
                    this.recommendations = [];
                    this.recommendationPlaylistId = null;
                    this.saveState();
                    this.notify('state');
                    return;
                }
            }
            const availableTracks = tracks.filter(t => t.isAvailable !== false && !qIds.has(t.id));
            this.applyRecommendations(availableTracks, forceReplace);
            if (rid && (rid.startsWith('OLAK') || rid.startsWith('PL') || rid.startsWith('RD'))) {
                this.recommendationPlaylistId = null;
                this.saveState();
            }
        }
    }

    private scRadioQuery(videoId: string): { track: YTMTrack | undefined, query: string } {
        const track = (this.currentTrack?.id === videoId) ? this.currentTrack : this.queue.find(t => t.id === videoId);
        const query = [track?.artists?.[0], track?.title].filter(Boolean).join(' ').trim();
        return { track, query };
    }

    private applyRecommendations(fresh: YTMTrack[], forceReplace: boolean) {
        if (fresh.length === 0) return;
        if (forceReplace || this.recommendations.length === 0) {
            this.recommendations = fresh.slice(0, 200);
        } else {
            const existing = new Set(this.recommendations.map(t => t.id));
            this.recommendations = [...this.recommendations, ...fresh.filter(t => !existing.has(t.id))].slice(0, 150);
        }
    }

    // SC-радио от трека: сначала track-related (качество + персонализация при авторизации),
    // затем фолбэк на поиск по «artist title».
    private async scRadioTracks(videoId: string): Promise<YTMTrack[]> {
        const { track, query } = this.scRadioQuery(videoId);
        const url = track?.scUrl || (isSoundCloudId(videoId) ? videoId : undefined);
        let scTracks = await getScRecommendations({ scId: track?.scId, url });
        // Если related отдал мало — добираем поиском по «artist title» (до 25), без дублей.
        if (scTracks.length < 10 && query) {
            const extra = await searchSoundCloud(query, 25);
            const ids = new Set(scTracks.map(t => t.id));
            scTracks = [...scTracks, ...extra.filter(t => !ids.has(t.id))];
        }
        return scTracks;
    }

    private async fetchSoundCloudRadio(videoId: string, forceReplace: boolean) {
        const scTracks = await this.scRadioTracks(videoId);
        const qIds = new Set(this.queue.map(t => t.id));
        const fresh = scTracks.filter(t => t.id !== videoId && !qIds.has(t.id));
        this.applyRecommendations(fresh, forceReplace);
    }

    private async fetchHybridRecommendations(videoId: string, forceReplace: boolean) {
        const { track, query } = this.scRadioQuery(videoId);
        const seedIsSc = track?.source === 'soundcloud' || isSoundCloudId(videoId);
        let ytSeedId: string | null = videoId;
        let rid: string | null;
        if (seedIsSc) {
            // От SC-id YT-рекомендаций нет — матчим SC-трек к YouTube (как E3, в обратную сторону).
            ytSeedId = query ? await this.findYouTubeSeed(query, track) : null;
            rid = null;
        } else {
            rid = track ? this.resolveContextId(track, this.recommendationPlaylistId, this.queueSourceId) : (this.recommendationPlaylistId || this.queueSourceId);
        }
        const [ytRes, scTracks] = await Promise.all([
            ytSeedId ? getQueueRecommendations(ytSeedId, rid) : Promise.resolve({ tracks: [] as YTMTrack[] }),
            this.scRadioTracks(videoId),
        ]);
        const qIds = new Set(this.queue.map(t => t.id));
        const ytFresh = (ytRes.tracks || []).filter(t => t.isAvailable !== false && t.id !== videoId && !qIds.has(t.id));
        const scFresh = scTracks.filter(t => t.id !== videoId && !qIds.has(t.id));
        // При forceReplace явно сбрасываем, чтобы hybrid-refresh точно заменил оба источника,
        // а не смешал новые треки с остатками старых рекомендаций.
        if (forceReplace) this.recommendations = [];
        this.applyRecommendations(interleaveTracks(ytFresh, scFresh), forceReplace);
    }

    // Подбираем YouTube-видео под SC-трек (для гибрид-рекомендаций от SC-сида).
    private async findYouTubeSeed(query: string, track?: YTMTrack): Promise<string | null> {
        try {
            const candidates = await searchMore(query, 0, 'songs');
            const match = pickBestScMatch(candidates, this.parseDuration(track?.duration || '0:00'));
            return match?.id || candidates[0]?.id || null;
        } catch {
            return null;
        }
    }

    async togglePlay() {
        if (!this.currentTrack) return;
        await this.initAudioContext();
        if (this.isStreamLoading) {
            this.isPlaying = !this.isPlaying;
            this.notify('state');
            return;
        }

        const currentUrl = this.activeAudio.src;
        // Check if URL is expired or close to it (within 30 seconds)
        // Local files (file:///) don't expire.
        const isExpired = currentUrl && 
                         !this.isCurrentTrackLocal && 
                         getExpirationFromUrl(currentUrl) < Math.floor(Date.now() / 1000) + 30;

        if (this.hasStreamError || (!this.audioA.src && !this.audioB.src) || isExpired) { 
            const savedTime = this.activeAudio.currentTime;
            await this.startPlayback(this.currentTrack, false, isExpired ? savedTime : 0); 
            return; 
        }

        if (this.isPlaying) this.activeAudio.pause();
        else await this.activeAudio.play();
    }

    async next(fromError: boolean = false) {
        if (this.queue.length === 0) return;

        let nextIndex = this.queueIndex;
        let isSeamless = false;

        nextIndex++;
        if (nextIndex >= this.queue.length) {
            if (this.repeat === 'all') nextIndex = 0;
            else if (this.autoplay && this.recommendations.length > 0) {
                const nextTrack = this.recommendations[0];
                this.queue = [...this.queue, nextTrack];
                this.recommendations = this.recommendations.slice(1);
            } else {
                this.isPlaying = false;
                this.hasStreamError = fromError;
                this.notify('state'); this.saveState(); return;
            }
        }

        const nextTrack = this.queue[nextIndex];

        if (!this.shuffle && this.preloadedTrackId === nextTrack.id) {
            const prevAudio = this.activeAudio;
            this.wtFlush('paused');
            this.wtUrl = null;
            this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
            const nextAudio = this.activeAudio;

            this.queueIndex = nextIndex;
            this.currentTrack = nextTrack;
            this.duration = this.parseDuration(nextTrack.duration);
            this.currentTime = 0;
            this.preloadedTrackId = null;

            nextAudio.volume = this.volume / 100;
            const entry = await streamCache.get(nextTrack.id);
            this.applyNormalization(entry?.loudness || 0);

            try {
                await nextAudio.play();
                if (entry?.watchtimeUrl) this.initWatchtime(entry.watchtimeUrl);
                prevAudio.pause();
                prevAudio.removeAttribute('src');
                prevAudio.load();

                this.saveState();
                this.notify('state');
                this.prefetchBuffer();
                isSeamless = true;
            } catch (e) {
                console.error('[player] Seamless play failed, falling back', e);
            }
        }

        if (!isSeamless) {
            this.queueIndex = nextIndex;
            await this.playCurrentTrack();
        }
    }

    async prev() {
        if (this.currentTime > 3) { this.activeAudio.currentTime = 0; return; }
        if (this.queueIndex > 0) { this.queueIndex--; await this.playCurrentTrack(); }
    }

    async seek(time: number) {
        const active = this.activeAudio;
        if (active.src) {
            active.currentTime = time;
            this.currentTime = time;
            this.updateRPC(true);
            this.notify('tick'); 
        }
    }

    setVolume(vol: number) {
        const newVol = Math.max(0, Math.min(100, vol));
        if (this.volume === newVol) return;
        this.volume = newVol;
        this.audioA.volume = this.volume / 100;
        this.audioB.volume = this.volume / 100;
        if (this.volume > 0) this.lastVolume = this.volume;
        this.saveState();
        this.notify('state');
    }

    toggleMute() {
        if (this.volume > 0) { this.lastVolume = this.volume; this.setVolume(0); }
        else { this.setVolume(this.lastVolume || 80); }
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        if (this.shuffle) {
            this.originalQueue = [...this.queue];
            const shuffled = [...this.queue];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            // Move current track to front so upcoming queue is fully visible
            if (this.currentTrack) {
                const idx = shuffled.findIndex(t => t.id === this.currentTrack!.id);
                if (idx > 0) [shuffled[0], shuffled[idx]] = [shuffled[idx], shuffled[0]];
            }
            this.queue = shuffled;
            this.queueIndex = 0;
        } else {
            this.queue = [...this.originalQueue];
            this.originalQueue = [];
            if (this.currentTrack) {
                const idx = this.queue.findIndex(t => t.id === this.currentTrack!.id);
                this.queueIndex = idx !== -1 ? idx : 0;
            }
        }
        this.saveState();
        this.notify('state');
    }
    toggleRepeat() {
        const modes: Array<'off' | 'all' | 'one'> = ['off', 'all', 'one'];
        this.repeat = modes[(modes.indexOf(this.repeat) + 1) % modes.length];
        this.saveState();
        this.notify('state');
    }
    toggleAutoplay() { this.autoplay = !this.autoplay; this.saveState(); this.notify('state'); }

    setRadioMode(mode: 'youtube' | 'soundcloud' | 'hybrid') {
        if (this.radioMode === mode) return;
        this.radioMode = mode;
        this.saveState();
        this.notify('state');
        if (this.currentTrack) this.fetchRecommendations(this.currentTrack.id, true);
    }

    getUpcoming(): YTMTrack[] {
        if (this.queueIndex < 0) return [];
        return this.queue.slice(this.queueIndex + 1);
    }

    async playFromQueue(index: number) {
        if (index < 0 || index >= this.queue.length) return;
        this.queueIndex = index;
        await this.playCurrentTrack();
    }

    async rateCurrentTrack(status: 'LIKE' | 'DISLIKE' | 'INDIFFERENT') {
        if (!this.currentTrack) return;
        // Capture before await — currentTrack may change if user switches tracks
        const track = this.currentTrack;
        const currentStatus = track.likeStatus || 'INDIFFERENT';

        // Route to correct toggle based on desired new status
        // (SoundCloud-маршрутизация лайка — внутри likedManager, общая для плеера/очереди/строк)
        const isDislikeAction = status === 'DISLIKE' || (status === 'INDIFFERENT' && currentStatus === 'DISLIKE');
        const success = isDislikeAction
            ? await likedManager.toggleDislike(track, currentStatus)
            : await likedManager.toggleLike(track, currentStatus);

        if (success) {
            track.likeStatus = status;
            // Only update queue entry if it still belongs to the same track
            if (this.queueIndex >= 0 && this.queue[this.queueIndex]?.id === track.id) {
                this.queue[this.queueIndex].likeStatus = status;
            }
            this.notify('state');
            this.saveState();
        }
    }

    reset() {
        this.audioA.pause();
        this.audioB.pause();
        this.audioA.removeAttribute('src');
        this.audioB.removeAttribute('src');
        this.audioA.load();
        this.audioB.load();
        
        if (this.audioContext?.state === 'running') this.audioContext.suspend();
        this.currentTrack = null;
        this.queue = []; this.queueIndex = -1;
        this.queueSourceId = null; this.recommendationPlaylistId = null;
        this.recommendations = []; this.isPlaying = false; this.currentTime = 0; this.duration = 0;
        this.activePlayer = 'A';
        this.preloadedTrackId = null;
        
        localStorage.removeItem('ytm-last-track');
        localStorage.removeItem('ytm-queue');
        localStorage.removeItem('ytm-queue-index');
        localStorage.removeItem('ytm-queue-source');
        localStorage.removeItem('ytm-recommendation-id');
        this.notify('state');
    }

    private parseDuration(dur: string): number {
        if (!dur) return 0;
        const parts = dur.split(':').map(Number);
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }
}

export const player = new PlayerStore();
