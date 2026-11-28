import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    player as playerSingleton,
    normalizeYouTubeRecommendationId as normalizeFn,
    isValidRecommendationContextId as validContextFn,
} from './player';
import type { YTMTrack } from './yt';

const {
    getQueueRecommendations,
    searchSoundCloud,
    getScRecommendations,
    getStreamUrl,
} = vi.hoisted(() => ({
    getQueueRecommendations: vi.fn(),
    searchSoundCloud: vi.fn(),
    getScRecommendations: vi.fn(),
    getStreamUrl: vi.fn(),
}));

vi.mock('./yt', () => ({
    getQueueRecommendations,
    rateSong: vi.fn(),
    searchMore: vi.fn().mockResolvedValue([]),
}));

vi.mock('./soundcloud', () => ({
    searchSoundCloud,
    getScRecommendations,
    isSoundCloudEnabled: () => true,
    isSoundCloudId: (id: string) => id.startsWith('sc:'),
    pickBestScMatch: (tracks: YTMTrack[]) => tracks[0],
    interleaveMany: (lists: YTMTrack[][]) => {
        const out: YTMTrack[] = [];
        const max = Math.max(0, ...lists.map(l => l.length));
        for (let i = 0; i < max; i++) {
            for (const list of lists) {
                if (i < list.length) out.push(list[i]);
            }
        }
        return out;
    },
    createTrackDedupIndex: (initial: YTMTrack[] = []) => {
        const seen = new Set(initial.map(t => t.id));
        return { has: (t: YTMTrack) => seen.has(t.id), add: (t: YTMTrack) => seen.add(t.id) };
    },
    getQueueDedupIndex: (queue: YTMTrack[]) => {
        const seen = new Set(queue.map(t => t.id));
        return { has: (t: YTMTrack) => seen.has(t.id), add: (t: YTMTrack) => seen.add(t.id) };
    },
}));

vi.mock('./yandex', () => ({
    isYandexEnabled: () => false,
    searchYandex: vi.fn().mockResolvedValue([]),
    getYandexRecommendations: vi.fn().mockResolvedValue([]),
    getYandexWaveTracks: vi.fn().mockResolvedValue([]),
    yandexRotorFeedback: vi.fn(),
    yandexPlayAudio: vi.fn(),
}));

vi.mock('./stream', () => ({
    getStreamUrl,
    prefetchStreamUrl: vi.fn().mockResolvedValue(undefined),
    getExpirationFromUrl: () => Number.MAX_SAFE_INTEGER,
    registerSoundCloudTrack: vi.fn(),
    registerYandexTrack: vi.fn(),
    ensureLoudness: vi.fn().mockResolvedValue(null),
    ensureLocalLoudness: vi.fn().mockResolvedValue(null),
    getLocalOverrideEntry: vi.fn().mockResolvedValue(null),
}));

vi.mock('./cache', () => ({
    streamCache: {
        init: async () => {},
        clearExpired: async () => {},
        get: async () => null,
    },
}));

vi.mock('./likedManager', () => ({
    likedManager: { toggleLike: vi.fn(), toggleDislike: vi.fn() },
}));

vi.mock('./localOverrides', () => ({
    deleteOverride: vi.fn(),
    onOverrideChanged: vi.fn(),
}));

class TestAudio extends EventTarget {
    src = '';
    volume = 1;
    paused = true;
    currentTime = 0;
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    load() {}
    removeAttribute() { this.src = ''; }
}

const makeTrack = (id: string, title: string, artist = 'Bladee', source?: 'soundcloud'): YTMTrack => ({
    id,
    title,
    artists: [artist],
    duration: '2:30',
    album: '',
    thumbUrl: '',
    ...(source ? { source, scUrl: `https://soundcloud.com/test/${id}` } : {}),
});

let player: typeof playerSingleton;
let normalizeYouTubeRecommendationId: typeof normalizeFn;
let isValidRecommendationContextId: typeof validContextFn;

beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.stubGlobal('Audio', TestAudio);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
        bridge: { clearRPC: vi.fn(), updateRPC: vi.fn(), pyCall: vi.fn().mockResolvedValue({ status: 'ok' }) },
    }));

    ({ player, normalizeYouTubeRecommendationId, isValidRecommendationContextId } = await import('./player'));
    player.rpcEnabled = false;
    vi.spyOn(player, 'initAudioContext').mockResolvedValue(undefined);
    getStreamUrl.mockResolvedValue({ url: 'https://test.googlevideo.com/videoplayback', loudness: 0 });
    searchSoundCloud.mockResolvedValue([]);
    getScRecommendations.mockResolvedValue([]);
    getQueueRecommendations.mockResolvedValue({ tracks: [] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('recommendation context validation', () => {
    it('accepts valid YouTube playlist/mix IDs and rejects arbitrary UI sourceIds', () => {
        expect(normalizeYouTubeRecommendationId('OLAK5uy_abc')).toBe('OLAK5uy_abc');
        expect(normalizeYouTubeRecommendationId('PL12345')).toBe('PL12345');
        expect(normalizeYouTubeRecommendationId('RDAMVMxyz')).toBe('RDAMVMxyz');
        expect(normalizeYouTubeRecommendationId('VLPL12345')).toBe('PL12345');
        expect(normalizeYouTubeRecommendationId('MLCT')).toBe('MLCT');

        expect(normalizeYouTubeRecommendationId('history')).toBeNull();
        expect(normalizeYouTubeRecommendationId('bladee')).toBeNull();
        expect(normalizeYouTubeRecommendationId('my-wave')).toBeNull();
        expect(normalizeYouTubeRecommendationId('UC12345')).toBeNull();
        expect(normalizeYouTubeRecommendationId('MPREb_album')).toBeNull();
        expect(normalizeYouTubeRecommendationId('LM')).toBeNull();
        expect(normalizeYouTubeRecommendationId('VLLM')).toBeNull();
        expect(normalizeYouTubeRecommendationId('user:onyourwave')).toBeNull();

        expect(isValidRecommendationContextId('user:onyourwave')).toBe(true);
        expect(isValidRecommendationContextId('history')).toBe(false);
        expect(isValidRecommendationContextId('bladee')).toBe(false);
    });

    it('does not leak search query or history sourceId into YouTube recommendations', async () => {
        const bladee = makeTrack('bladee_id', 'Be Nice 2 Me', 'Bladee');
        const rec = makeTrack('yt_rec_1', 'Obedient', 'Bladee');
        getQueueRecommendations.mockResolvedValue({ tracks: [rec] });

        await player.playSingle(bladee, 'history');
        await vi.waitFor(() => expect(player.recommendations.map(t => t.id)).toEqual(['yt_rec_1']));
        expect(getQueueRecommendations).toHaveBeenCalledWith('bladee_id', null);

        getQueueRecommendations.mockClear();
        await player.playTrackList([bladee], 0, 'bladee');
        await vi.waitFor(() => expect(getQueueRecommendations).toHaveBeenCalledWith('bladee_id', null));
    });
});

describe('in-flight recommendation superseding', () => {
    it('fetches YT + SC recommendations for a newly launched track even while a previous fetch is still in flight', async () => {
        const prevTrack = makeTrack('prev_track', 'Prev Song', 'Other Artist');
        const bladeeTrack = makeTrack('bladee_track', 'Be Nice 2 Me', 'Bladee');
        const prevRec = makeTrack('prev_rec', 'Stale Rec', 'Other Artist');
        const bladeeYtRec = makeTrack('bladee_yt_rec', 'Reality Surf', 'Bladee');
        const bladeeScRec = makeTrack('sc:bladee_sc_rec', 'Drain Story', 'Bladee', 'soundcloud');

        let resolvePrevYt!: (v: { tracks: YTMTrack[] }) => void;
        let resolvePrevSc!: (v: YTMTrack[]) => void;
        let resolveBladeeYt!: (v: { tracks: YTMTrack[] }) => void;
        let resolveBladeeSc!: (v: YTMTrack[]) => void;

        getQueueRecommendations.mockImplementation((videoId: string) => {
            if (videoId === 'prev_track') return new Promise(r => { resolvePrevYt = r; });
            if (videoId === 'bladee_track') return new Promise(r => { resolveBladeeYt = r; });
            return Promise.resolve({ tracks: [] });
        });
        searchSoundCloud.mockImplementation((query: string, limit?: number) => {
            if (limit === 3 && query.includes('Prev Song')) return new Promise(r => { resolvePrevSc = r; });
            if (limit === 3 && query.includes('Be Nice 2 Me')) return new Promise(r => { resolveBladeeSc = r; });
            return Promise.resolve([]);
        });
        getScRecommendations.mockImplementation((opts?: { url?: string }) => {
            if (opts?.url?.includes('bladee_sc_rec')) return Promise.resolve([bladeeScRec]);
            return Promise.resolve([]);
        });

        player.radioSources = ['youtube', 'soundcloud'];

        // Запускаем первый трек: его запрос рекомендаций завис в полете.
        await player.playSingle(prevTrack);
        expect(player.isRecommendationsLoading).toBe(true);
        expect(getQueueRecommendations).toHaveBeenCalledWith('prev_track', null);

        // Пока первый запрос еще не завершился, запускаем трек Bladee.
        await player.playSingle(bladeeTrack);
        expect(player.isRecommendationsLoading).toBe(true);
        expect(getQueueRecommendations).toHaveBeenCalledWith('bladee_track', null);

        // Завершаем устаревший запрос первого трека: он не должен сбрасывать флаг загрузки
        // и не должен подмешивать чужие рекомендации.
        resolvePrevYt({ tracks: [prevRec] });
        resolvePrevSc([]);
        await Promise.resolve();
        await Promise.resolve();
        expect(player.isRecommendationsLoading).toBe(true);
        expect(player.recommendations).toEqual([]);

        // Завершаем актуальный запрос для Bladee: приходят оба источника (YT + SC).
        resolveBladeeYt({ tracks: [bladeeYtRec] });
        resolveBladeeSc([bladeeScRec]);
        await vi.waitFor(() => expect(player.isRecommendationsLoading).toBe(false));
        expect(player.recommendations.map(t => t.id)).toEqual(['bladee_yt_rec', 'sc:bladee_sc_rec']);
    });

    it('supersedes an in-flight fetch when active radio sources change', async () => {
        const bladeeTrack = makeTrack('bladee_track', 'Be Nice 2 Me', 'Bladee');
        const ytRec = makeTrack('yt_rec', 'Reality Surf', 'Bladee');
        const scRec = makeTrack('sc:sc_rec', 'Sugar', 'Bladee', 'soundcloud');

        let resolveFirstYt!: (v: { tracks: YTMTrack[] }) => void;
        getQueueRecommendations
            .mockImplementationOnce(() => new Promise(r => { resolveFirstYt = r; }))
            .mockResolvedValueOnce({ tracks: [ytRec] });
        searchSoundCloud.mockResolvedValue([scRec]);

        player.radioSources = ['youtube'];
        await player.playSingle(bladeeTrack);
        expect(player.isRecommendationsLoading).toBe(true);

        // Включаем SoundCloud, пока первый YT-запрос еще в полете.
        player.setActiveSources(['youtube', 'soundcloud']);
        await vi.waitFor(() => expect(player.recommendations.map(t => t.id)).toEqual(['yt_rec', 'sc:sc_rec']));

        // Поздний ответ старого YT-only запроса игнорируется.
        resolveFirstYt({ tracks: [makeTrack('stale_yt', 'Stale')] });
        await Promise.resolve();
        expect(player.recommendations.map(t => t.id)).toEqual(['yt_rec', 'sc:sc_rec']);
    });

    it('does not trigger duplicate recommendation fetches on startRadio for a new track', async () => {
        const bladeeTrack = makeTrack('bladee_track', 'Be Nice 2 Me', 'Bladee');
        const rec = makeTrack('yt_rec', 'Obedient', 'Bladee');
        getQueueRecommendations.mockResolvedValue({ tracks: [bladeeTrack, rec] });

        await player.startRadio(bladeeTrack);
        expect(getQueueRecommendations).toHaveBeenCalledTimes(1);
        expect(getQueueRecommendations).toHaveBeenCalledWith('bladee_track', 'RDAMVMbladee_track');
        expect(player.queue.map(t => t.id)).toEqual(['bladee_track', 'yt_rec']);
    });
});
