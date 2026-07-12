import { player } from './player';

let initialized = false;
let lastTrackId: string | null = null;

function formatDuration(seconds: number): number {
    return isFinite(seconds) ? seconds : 0;
}

function updateMetadata() {
    const track = player.currentTrack;
    if (!track || !('mediaSession' in navigator)) return;

    // Обновляем метаданные только при смене трека, чтобы не вызывать SMTC-фликер
    if (track.id === lastTrackId) return;
    lastTrackId = track.id;

    const artist = track.artists?.join(', ') || 'Неизвестный исполнитель';
    const title = track.title || 'Без названия';

    const artwork: MediaImage[] = [];
    if (track.thumbUrl) {
        artwork.push({ src: track.thumbUrl, sizes: '480x480', type: 'image/jpeg' });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album: track.album || '',
        artwork,
    });
}

function updatePlaybackState() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused';
}

function updatePositionState() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: formatDuration(player.duration),
            playbackRate: 1,
            position: formatDuration(player.currentTime),
        });
    } catch {
        // position state can throw if duration is 0 or NaN
    }
}

function handleStateEvent() {
    updateMetadata();
    updatePlaybackState();
    updatePositionState();
}

function handleTickEvent() {
    updatePositionState();
}

function setupActionHandlers() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => {
        if (!player.isPlaying) player.togglePlay();
    });

    navigator.mediaSession.setActionHandler('pause', () => {
        if (player.isPlaying) player.togglePlay();
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
        player.prev();
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
        player.next();
    });

    navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
            player.seek(details.seekTime);
        }
    });

    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const offset = details.seekOffset || 10;
        player.seek(Math.max(0, player.currentTime - offset));
    });

    navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const offset = details.seekOffset || 10;
        player.seek(Math.min(player.duration, player.currentTime + offset));
    });

    navigator.mediaSession.setActionHandler('stop', () => {
        if (player.isPlaying) player.togglePlay();
    });
}

export function initMediaSession() {
    if (initialized || !('mediaSession' in navigator)) return;
    initialized = true;

    setupActionHandlers();

    player.subscribe((event) => {
        if (event === 'state') handleStateEvent();
        else if (event === 'tick') handleTickEvent();
    }, { tick: true });

    // Sync initial state
    handleStateEvent();
}
