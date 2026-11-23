import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { player as playerSingleton } from './player';
import type { YTMTrack } from './yt';

const { searchMore, searchSoundCloud, getStreamUrl, toggleLike } = vi.hoisted(() => ({
  searchMore: vi.fn(), searchSoundCloud: vi.fn(), getStreamUrl: vi.fn(), toggleLike: vi.fn(),
}));
vi.mock('./yt', () => ({ searchMore, getQueueRecommendations: async () => ({ tracks: [] }) }));
vi.mock('./soundcloud', () => ({ searchSoundCloud, isSoundCloudEnabled: () => true, isSoundCloudId: () => false, pickBestScMatch: (tracks: YTMTrack[]) => tracks[0] }));
vi.mock('./yandex', () => ({ isYandexEnabled: () => false }));
vi.mock('./stream', () => ({ getStreamUrl, prefetchStreamUrl: vi.fn(), registerSoundCloudTrack: vi.fn() }));
vi.mock('./cache', () => ({ streamCache: { init: async () => {}, clearExpired: async () => {} } }));
vi.mock('./likedManager', () => ({ likedManager: { toggleLike } }));
vi.mock('./localOverrides', () => ({ onOverrideChanged: vi.fn() }));

const audio: TestAudio[] = [];
class TestAudio extends EventTarget {
    src = '';
    play = vi.fn().mockResolvedValue(undefined);
    constructor() { super(); audio.push(this); }
    pause = vi.fn();
    load() {}
    removeAttribute() { this.src = ''; }
}

const original: YTMTrack = { id: 'original', title: 'ДАСТ', artists: ['dmtboy'], duration: '1:15', album: '', thumbUrl: '', likeStatus: 'LIKE' };
const alternative: YTMTrack = { ...original, id: 'alternate', artists: ['dmtboy', 'takizava'], likeStatus: undefined };
const sc: YTMTrack = { ...alternative, id: 'sc', source: 'soundcloud', scUrl: 'https://soundcloud.com/example/dust' };
const youtubeUrl = 'https://test.googlevideo.com/videoplayback';
const scUrl = 'https://audio.invalid/sc';
let player: typeof playerSingleton;

beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    audio.length = 0;
    vi.stubGlobal('Audio', TestAudio);
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { bridge: { clearRPC: vi.fn() } }));
    // Модуль сразу создает плеер: импортируем после установки аудиосреды для каждого теста.
    ({ player } = await import('./player'));
    player.rpcEnabled = false;
    vi.spyOn(player, 'initAudioContext').mockResolvedValue(undefined);
    toggleLike.mockResolvedValue(true);
    searchSoundCloud.mockResolvedValue([sc]);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it('plays the matching YouTube version before SoundCloud and likes it only after playback starts', async () => {
    searchMore.mockResolvedValue([
        { ...alternative, id: 'wrong-duration', duration: '2:15' },
        { ...alternative, id: 'wrong-artist', artists: ['another artist', 'dmtboy'] },
        alternative,
    ]);
    getStreamUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: youtubeUrl, loudness: 0 });
    await player.playSingle({ ...original });
    await vi.waitFor(() => expect(audio[0].src).toBe(youtubeUrl));
    expect(getStreamUrl.mock.calls.map(([id]) => id)).toEqual(['original', 'original', 'alternate']);
    expect(toggleLike).not.toHaveBeenCalled();
    audio[0].dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(toggleLike).toHaveBeenCalledExactlyOnceWith(alternative, 'INDIFFERENT'));
    expect(searchSoundCloud).not.toHaveBeenCalled();
    expect(player.currentTrack?.id).toBe(original.id);
});

it('falls through to SoundCloud without liking a YouTube stream the audio player rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    searchMore.mockResolvedValue([alternative]);
    getStreamUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: youtubeUrl, loudness: 0 })
        .mockResolvedValueOnce({ url: scUrl, loudness: 0 });
    await player.playSingle({ ...original });
    await vi.waitFor(() => expect(audio[0].src).toBe(youtubeUrl));
    audio[0].dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(audio[0].src).toBe(scUrl));
    expect(toggleLike).not.toHaveBeenCalled();
});

it('does not like an alternate version if the original was not liked', async () => {
    searchMore.mockResolvedValue([alternative]);
    getStreamUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: youtubeUrl, loudness: 0 });
    await player.playSingle({ ...original, likeStatus: 'INDIFFERENT' });
    await vi.waitFor(() => expect(audio[0].src).toBe(youtubeUrl));
    audio[0].dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(player.isStreamLoading).toBe(false));
    expect(toggleLike).not.toHaveBeenCalled();
});

it('leaves playback paused when the replacement search finishes after a pause', async () => {
    let finishSearch!: (tracks: YTMTrack[]) => void;
    searchMore.mockReturnValue(new Promise<YTMTrack[]>(resolve => { finishSearch = resolve; }));
    getStreamUrl.mockResolvedValue(null);
    await player.playSingle({ ...original });
    await vi.waitFor(() => expect(searchMore).toHaveBeenCalledOnce());
    await player.togglePlay();
    finishSearch([alternative]);
    await vi.waitFor(() => expect(player.isStreamLoading).toBe(false));
    expect(player.isPlaying).toBe(false);
    expect(audio[0].src).toBe('');
    expect(toggleLike).not.toHaveBeenCalled();
});

it('does not resume or like the replacement when paused with play pending', async () => {
    let finishPlay!: () => void;
    audio[0].play.mockReturnValueOnce(new Promise<void>(resolve => { finishPlay = resolve; }));
    searchMore.mockResolvedValue([alternative]);
    getStreamUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: youtubeUrl, loudness: 0 });
    await player.playSingle({ ...original });
    await vi.waitFor(() => expect(audio[0].src).toBe(youtubeUrl));
    audio[0].dispatchEvent(new Event('canplay'));
    await player.togglePlay();
    audio[0].dispatchEvent(new Event('play'));
    finishPlay();
    await vi.waitFor(() => expect(player.isStreamLoading).toBe(false));
    expect(player.isPlaying).toBe(false);
    expect(toggleLike).not.toHaveBeenCalled();
});

it('tries SoundCloud instead of looping on a replacement that fails during playback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    searchMore.mockResolvedValue([alternative]);
    getStreamUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: youtubeUrl, loudness: 0 })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ url: scUrl, loudness: 0 });
    await player.playSingle({ ...original });
    await vi.waitFor(() => expect(audio[0].src).toBe(youtubeUrl));
    audio[0].dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(player.isStreamLoading).toBe(false));
    audio[0].dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(audio[0].src).toBe(scUrl));
    expect(getStreamUrl.mock.calls.map(([id]) => id)).toEqual(['original', 'original', 'alternate', 'original', 'original']);
});
