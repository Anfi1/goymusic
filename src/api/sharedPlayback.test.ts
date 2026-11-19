import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrackCredits } from '../components/molecules/TrackCredits';
import { player } from './player';
import { playSharedTrack } from './sharedPlayback';
import { canLookUpVideo, creditForVideo, loadVideoCard, withVideoCredits } from './trackCredits';
import { parseDeepLink } from './trackLink';
import type { YTMTrack } from './yt';

vi.mock('./player', () => ({ player: { startRadio: vi.fn(), applySharedVideoCard: vi.fn() } }));
vi.mock('./soundcloud', () => ({ resolveScTrack: vi.fn() }));
vi.mock('../components/atoms/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const videoId = 'c5D1bTJ1cig';
const channelId = 'UC' + 'a'.repeat(22);
const response = { status: 'ok', info: { videoDetails: { title: 'Video', author: 'скучна', channelId } } };
const meta = Buffer.from(JSON.stringify({ t: 'Shared title', a: ['скучна'], artistIds: ['untrusted'], i: 'https://untrusted.example/image' })).toString('base64url');
function link() {
  const parsed = parseDeepLink(`goymusic://track/${videoId}?m=${meta}&t=11`);
  if (parsed?.type !== 'track') throw new Error('Share did not parse');
  return parsed;
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('shared YouTube uploader credits', () => {
  it('starts playback immediately, ignoring supplied IDs and untrusted artwork', async () => {
    const pyCall = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('window', { bridge: { pyCall } });
    const client = new QueryClient();
    const opening = playSharedTrack(link(), client);
    const seed = vi.mocked(player.startRadio).mock.calls[0]?.[0];
    expect(seed).toMatchObject({ id: videoId, artists: ['скучна'], thumbUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` });
    expect(seed).not.toHaveProperty('artistIds');
    expect(player.startRadio).toHaveBeenCalledWith(seed, 11);
    expect(player.applySharedVideoCard).not.toHaveBeenCalled();
    // A click while metadata is in flight reuses the share lookup.
    const clicked = loadVideoCard(client, videoId);
    await opening;
    expect(creditForVideo(videoId, 'скучна', await clicked)).toBe(channelId);
    expect(player.applySharedVideoCard).toHaveBeenCalledWith(expect.objectContaining({ id: videoId, title: 'Video', artists: ['скучна'], artistIds: [channelId] }));
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenCalledWith('get_track_info', expect.objectContaining({ videoId }));
    client.clear();
  });

  it('keeps playback intact when metadata fails and does not cache the failure as a valid credit', async () => {
    const pyCall = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response);
    vi.stubGlobal('window', { bridge: { pyCall } });
    const client = new QueryClient();
    await playSharedTrack(link(), client);
    expect(player.startRadio).toHaveBeenCalledTimes(1);
    expect(player.applySharedVideoCard).not.toHaveBeenCalled();
    expect(creditForVideo(videoId, 'скучна', await loadVideoCard(client, videoId))).toBe(channelId);
    client.clear();
  });

  it('preserves catalog artists in either order of metadata and radio arrival', () => {
    const video: YTMTrack = { id: videoId, title: 'Video', artists: ['скучна'], artistIds: [channelId], album: '', duration: '', thumbUrl: '' };
    const catalog = { ...video, artists: ['Singer', 'Guest'], artistIds: ['UC' + 'b'.repeat(22), 'UC' + 'c'.repeat(22)] };
    expect(withVideoCredits(catalog, video)).toBe(catalog);
    const sparse = { ...video, artists: ['Unverified share credit'], artistIds: [] };
    expect(withVideoCredits(sparse, catalog)).toEqual(catalog);
    expect(withVideoCredits(sparse, video)).toEqual(video);
    expect(withVideoCredits({ ...sparse, id: 'other' }, video).artistIds).toEqual([]);
    expect(creditForVideo(videoId, 'Guest', catalog)).toBe(catalog.artistIds[1]);
    expect(creditForVideo('other', 'Guest', catalog)).toBeUndefined();
    expect(creditForVideo(videoId, 'скучна', catalog)).toBeUndefined();
    expect(creditForVideo(videoId, 'Guest', { ...catalog, artists: ['Guest', 'Guest'] })).toBeUndefined();
  });

  it('renders an addressable author on a sparse search row without fetching metadata', () => {
    const client = new QueryClient();
    const pyCall = vi.fn();
    vi.stubGlobal('window', { bridge: { pyCall } });
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(TrackCredits, { videoId, artists: ['скучна'], linkClass: 'credit', onSelectArtist: vi.fn() })));
    expect(markup).toContain('role="link"');
    expect(markup).toContain('>скучна</span>');
    expect(pyCall).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('only uses valid YouTube IDs for missing-author lookups', () => {
    expect(canLookUpVideo(videoId, undefined)).toBe(true);
    expect(canLookUpVideo(videoId, 'soundcloud')).toBe(false);
    expect(canLookUpVideo('yandex:123', undefined)).toBe(false);
    expect(parseDeepLink('goymusic://track/https%3A%2F%2Funtrusted.example')).toBeNull();
    expect(parseDeepLink(`goymusic://track/${videoId}/extra`)).toBeNull();
    expect(parseDeepLink('goymusic://track/sc/uploader/track')).toMatchObject({ source: 'soundcloud' });
    expect(parseDeepLink('goymusic://track/yandex:123')).toMatchObject({ source: 'yandex', yandexId: '123' });
  });
});
