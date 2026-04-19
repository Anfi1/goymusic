import { createCallId } from './callId';

export interface YTMTrack {
    id: string;
    title: string;
    artists?: string[];
    artistIds?: string[];
    album: string;
    albumId?: string;
    playlistId?: string;
    audioPlaylistId?: string;
    duration: string;
    thumbUrl: string;
    views?: string;
    isAvailable?: boolean;
    likeStatus?: 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
    setVideoId?: string; // Unique ID for a track in a specific playlist
    menu_tokens?: {
        pin?: string | null;
        unpin?: string | null;
        notInterested?: string | null;
    };
    isPinned?: boolean;
    description?: string;
}

export interface YTMArtist {
    id: string;
    name: string;
    thumbUrl: string;
    menu_tokens?: {
        pin?: string | null;
        unpin?: string | null;
        notInterested?: string | null;
    };
    isPinned?: boolean;
    description?: string;
    subscribers?: string;
}

export interface YTMPlaylist {
    id: string;
    title: string;
    thumbUrl: string;
    count?: string;
    author?: string;
    itemCount?: number;
    artists?: string[];
    artistIds?: string[];
    owned?: boolean;
    can_add?: boolean;
    menu_tokens?: {
        pin?: string | null;
        unpin?: string | null;
        notInterested?: string | null;
    };
    isPinned?: boolean;
    description?: string;
    continuation?: string | null;
}

export interface YTMAlbumInfo {
    id: string;
    title: string;
    artists: string[];
    artistIds?: string[];
    year?: string;
    thumbUrl: string;
    isExplicit?: boolean;
    menu_tokens?: {
        pin?: string | null;
        unpin?: string | null;
        notInterested?: string | null;
    };
    isPinned?: boolean;
    description?: string;
}

export interface YTMAlbum {
    id?: string;
    title: string;
    type?: string;
    thumbUrl: string;
    artists?: string[];
    artistIds?: string[];
    audioPlaylistId?: string;
    likeStatus?: string;
    menu_tokens?: {
        pin?: string | null;
        unpin?: string | null;
        notInterested?: string | null;
    };
    isPinned?: boolean;
    tracks: YTMTrack[];
    continuation?: string | null;
    year?: string;
    trackCount?: number;
    duration?: string;
}

export interface YTMUser {
    name: string;
    thumbUrl: string;
}

export interface YTMSearchResult {
    top?: any;
    correction?: string;
    artists: YTMArtist[];
    tracks: YTMTrack[];
    albums: YTMAlbumInfo[];
    playlists: YTMPlaylist[];
}

export interface YTMArtistDetail {
    name: string;
    description: string;
    thumbUrl: string;
    channelId?: string;
    subscribed: boolean;
    subscribers?: string;
    monthlyListeners?: string;
    views?: string;
    topSongs: YTMTrack[];
    // Превью (из первого запроса)
    albumsPreview: any[];
    albumsId?: string;
    albumsParams?: string;
    singlesPreview: any[];
    singlesId?: string;
    singlesParams?: string;
    videosPreview: any[];
    videosId?: string;
    playlistsPreview: any[];
    playlistsId?: string;
    related: YTMArtist[];
    seeAllSongsId?: string;
    seeAllSongsParams?: string;
    continuation?: string | null;
}

export interface YTMHomeSection {
    title: string;
    category?: string;
    contents: any[];
}

// ===== Bridge Access =====

async function pyCall(command: string, args: any = {}, signal?: AbortSignal) {
    const callId = createCallId();
    const label = `[Bridge] ${command} (${callId})`;
    
    if (signal) {
        if (signal.aborted) return { status: 'error', message: 'Aborted' };
        signal.addEventListener('abort', () => {
            console.log(`%c[Bridge] CANCELLING ${command} (${callId})`, 'color: #f38ba8; font-weight: bold;');
            (window as any).bridge.pyCancel(callId);
        }, { once: true });
    }

    console.groupCollapsed(`%c${label}`, 'color: #89b4fa; font-weight: bold; font-size: 11px;');
    console.log('Arguments:', { ...args, callId });
    
    try {
        const res = await (window as any).bridge.pyCall(command, { ...args, callId });
        
        if (!res) {
            console.error('%cBRIDGE ERROR:', 'font-weight: bold; color: #f38ba8;', 'No response from bridge');
            console.groupEnd();
            return { status: 'error', message: 'No response from bridge' };
        }

        if (res.status === 'error') {
            if (res.message === 'Cancelled by client') {
                console.warn('%cBRIDGE CANCELLED', 'font-weight: bold; color: #fab387;');
            } else {
                console.error('%cPYTHON:', 'font-weight: bold; color: #f38ba8;', res.message);
            }
            console.groupEnd();
            return res;
        }
        
        console.log('Response:', res);
        console.groupEnd();
        return res;
    } catch (e) {
        if (signal?.aborted) {
            console.warn('%cBRIDGE ABORTED (Exception)', 'font-weight: bold; color: #fab387;');
        } else {
            console.error('%cBRIDGE EXCEPTION:', 'font-weight: bold; color: #f38ba8;', e);
        }
        console.groupEnd();
        return { status: 'error', message: String(e) };
    }
}

export async function isLoggedIn(): Promise<boolean> {
    try {
        const res = await pyCall('check_auth');
        return res.authenticated;
    } catch (e) {
        return false;
    }
}

export async function loadAuth(): Promise<boolean> {
    try {
        const res = await pyCall('load_auth');
        return res.authenticated;
    } catch (e) {
        return false;
    }
}

export async function clearTokens() {
    await pyCall('logout');
}

export async function getLibraryPlaylists(): Promise<YTMPlaylist[]> {
    const res = await pyCall('get_playlists');
    if (res.status === 'ok') {
        return res.playlists;
    }
    return [];
}

export async function getUserInfo(): Promise<YTMUser | null> {
    const res = await pyCall('get_user_info');
    if (res.status === 'ok') {
        return {
            name: res.name,
            thumbUrl: res.thumbUrl
        };
    }
    return null;
}

export async function getLikedSongs(limit: number | null = null, signal?: AbortSignal): Promise<{ tracks: YTMTrack[], trackCount: number }> {
    const res = await pyCall('get_liked_songs', { limit }, signal);
    if (res.status === 'ok') {
        return { 
            tracks: res.tracks || [], 
            trackCount: res.trackCount || (res.tracks?.length || 0) 
        };
    }
    return { tracks: [], trackCount: 0 };
}

export async function getLikedSongsCount(): Promise<number> {
    const res = await pyCall('get_liked_songs', { limit: 1 });
    return res.trackCount || 0;
}

export async function addToHistory(videoId: string): Promise<void> {
    const res = await pyCall('add_history_item', { videoId });
    if (res.status === 'ok') {
        console.log(`%c[history] YT history sent for ${videoId}`, 'color: #a6e3a1; font-weight: bold;');
    } else {
        console.error(`%c[history] Failed to send YT history for ${videoId}:`, 'color: #f38ba8;', res.message);
    }
}

export async function getPlaylistTracks(playlistId: string, limit: number | null = null, signal?: AbortSignal): Promise<{ 
    tracks: YTMTrack[], 
    trackCount: number, 
    continuation?: string | null,
    title?: string,
    description?: string,
    author?: { name: string, id?: string },
    owned?: boolean,
    privacy?: string,
    year?: string,
    duration?: string,
    duration_seconds?: number,
    thumbUrl?: string,
    audioPlaylistId?: string,
    likeStatus?: string,
    menu_tokens?: any,
    isPinned?: boolean
}> {
    const res = await pyCall('get_playlist_tracks', { playlistId, limit }, signal);
    if (res.status === 'ok') {
        return { 
            tracks: res.tracks || [], 
            trackCount: res.trackCount || (res.tracks?.length || 0),
            continuation: res.continuation,
            title: res.title,
            description: res.description,
            author: res.author,
            owned: res.owned,
            privacy: res.privacy,
            year: res.year,
            duration: res.duration,
            duration_seconds: res.duration_seconds,
            thumbUrl: res.thumbUrl,
            audioPlaylistId: res.audioPlaylistId,
            likeStatus: res.likeStatus,
            menu_tokens: res.menu_tokens,
            isPinned: res.isPinned
        };
    }
    return { tracks: [], trackCount: 0 };
}

export async function getAlbum(albumId: string, signal?: AbortSignal): Promise<YTMAlbum | null> {
    const res = await pyCall('get_album', { albumId }, signal);
    if (res.status === 'ok') {
        return {
            id: res.id,
            title: res.title,
            type: res.type,
            thumbUrl: res.thumbUrl,
            artists: res.artists,
            artistIds: res.artistIds,
            year: res.year,
            duration: res.duration,
            trackCount: res.trackCount,
            audioPlaylistId: res.audioPlaylistId,
            likeStatus: res.likeStatus,
            menu_tokens: res.menu_tokens,
            isPinned: res.isPinned,
            tracks: res.tracks || [],
            continuation: res.continuation
        };
    }
    return null;
}

export async function searchMusic(query: string): Promise<YTMSearchResult> {
    const res = await pyCall('search', { query });
    if (res.status === 'ok' && res.results) {
        return {
            top: res.results.top,
            correction: res.results.correction,
            artists: res.results.artists || [],
            tracks: res.results.tracks || [],
            albums: res.results.albums || [],
            playlists: res.results.playlists || []
        };
    }
    return { artists: [], tracks: [], albums: [], playlists: [] };
}

export async function getSearchSuggestions(query: string): Promise<string[]> {
    const res = await pyCall('get_search_suggestions', { query });
    if (res.status === 'ok') {
        return res.suggestions || [];
    }
    return [];
}

export async function searchMore(query: string, offset: number, filter: 'songs' | 'videos' | 'artists' | 'albums' | 'playlists' = 'songs'): Promise<any[]> {
    const res = await pyCall('search_more', { query, offset, filter });
    if (res.status === 'ok') {
        return res.items || [];
    }
    return [];
}

export async function getArtistDetail(artistId: string): Promise<YTMArtistDetail | null> {
    const res = await pyCall('get_artist', { artistId });
    if (res.status === 'ok') {
        return res;
    }
    return null;
}

export async function getArtistSongs(browseId: string, params?: string): Promise<{ tracks: YTMTrack[], continuation: string | null }> {
    const res = await pyCall('get_artist_songs', { browseId, params });
    if (res.status === 'ok') {
        return {
            tracks: res.tracks || [],
            continuation: res.continuation || null
        };
    }
    return { tracks: [], continuation: null };
}

export async function subscribeArtist(channelId: string): Promise<boolean> {
    const res = await pyCall('subscribe_artist', { channelId });
    return res.status === 'ok';
}

export async function unsubscribeArtist(channelId: string): Promise<boolean> {
    const res = await pyCall('unsubscribe_artist', { channelId });
    return res.status === 'ok';
}

export async function getHome(limit: number = 10): Promise<YTMHomeSection[]> {
    const res = await pyCall('get_home', { limit });
    if (res.status === 'ok') {
        return res.data;
    }
    return [];
}

export async function getHomeSections(continuation?: string | null): Promise<{ sections: YTMHomeSection[], continuation: string | null }> {
    const res = await pyCall('get_home_sections', { continuation: continuation ?? null });
    if (res.status === 'ok') {
        return { sections: res.sections ?? [], continuation: res.continuation ?? null };
    }
    return { sections: [], continuation: null };
}

export async function getQueueRecommendations(videoId: string, recommendationPlaylistId: string | null = null): Promise<{ tracks: YTMTrack[], relatedId?: string }> {
    const res = await pyCall('get_queue_recommendations', { videoId, recommendationPlaylistId });
    if (res.status === 'ok') {
        return {
            tracks: res.tracks || [],
            relatedId: res.relatedId
        };
    }
    return { tracks: [] };
}

export async function getSongRelated(browseId: string): Promise<any[]> {
    const res = await pyCall('get_song_related', { browseId });
    if (res.status === 'ok') {
        return res.sections || [];
    }
    return [];
}

export async function getTrackInfo(videoId: string): Promise<any> {
    const res = await pyCall('get_track_info', { videoId });
    if (res.status === 'ok') {
        return res.info;
    }
    return null;
}

export async function getLyrics(artist: string, title: string, duration?: number): Promise<{ plainLyrics?: string, syncedLyrics?: string } | null> {
    const res = await pyCall('get_lyrics', { artist, title, duration });
    if (res.status === 'ok') {
        return {
            plainLyrics: res.plainLyrics,
            syncedLyrics: res.syncedLyrics
        };
    }
    return null;
}

export async function rateSong(videoId: string, status: 'LIKE' | 'DISLIKE' | 'INDIFFERENT'): Promise<boolean> {
    const res = await pyCall('rate_song', { videoId, status });
    return res.status === 'ok';
}

export async function getExploreReleases(): Promise<any> {
    const res = await pyCall('get_explore_releases');
    if (res.status === 'ok') return res.sections;
    return [];
}

export async function ratePlaylist(playlistId: string, status: 'LIKE' | 'DISLIKE' | 'INDIFFERENT'): Promise<boolean> {
    const res = await pyCall('rate_playlist', { playlistId, status });
    return res.status === 'ok';
}

export async function createPlaylist(title: string, videoIds?: string[]): Promise<string | null> {
    const res = await pyCall('create_playlist', { title, videoIds });
    if (res.status === 'ok') {
        return res.playlistId;
    }
    return null;
}

export async function deletePlaylist(playlistId: string): Promise<boolean> {
    const res = await pyCall('delete_playlist', { playlistId });
    return res.status === 'ok';
}

export async function editPlaylist(playlistId: string, options: { 
    title?: string, 
    description?: string, 
    privacyStatus?: 'PUBLIC' | 'PRIVATE' | 'UNLISTED',
    moveItem?: [string, string], // [setVideoId, beforeSetVideoId]
    addToTop?: boolean
}): Promise<boolean> {
    const res = await pyCall('edit_playlist', { playlistId, ...options });
    return res.status === 'ok';
}

export async function addPlaylistItems(playlistId: string, videoIds: string[], duplicates: boolean = false): Promise<boolean> {
    const res = await pyCall('add_playlist_items', { playlistId, videoIds, duplicates });
    return res.status === 'ok';
}

export async function removePlaylistItems(playlistId: string, videos: { videoId: string, setVideoId: string }[]): Promise<boolean> {
    const res = await pyCall('remove_playlist_items', { playlistId, videos });
    return res.status === 'ok';
}

export async function sendFeedback(token: string): Promise<boolean> {
    const res = await pyCall('send_feedback', { token });
    return res.status === 'ok';
}

export async function getContinuation(token: string): Promise<{ tracks: YTMTrack[], continuation: string | null }> {
    const res = await pyCall('get_continuation', { token });
    if (res.status === 'ok') {
        return {
            tracks: res.tracks || [],
            continuation: res.continuation || null
        };
    }
    return { tracks: [], continuation: null };
}

export interface YTMMix {
    title: string;
    playlistId: string;
    thumbUrl: string;
}

export async function getMixedForYou(): Promise<YTMMix[]> {
    const res = await pyCall('get_mixed_for_you');
    if (res.status === 'ok') return res.mixes ?? [];
    return [];
}

export async function yandexImportStreaming(token: string, startIndex: number = 0, signal?: AbortSignal): Promise<{ matched: number; notFound: number }> {
    const res = await pyCall('yandex_import_streaming', { token, startIndex }, signal);
    if (res.status === 'ok') return { matched: res.matched, notFound: res.notFound };
    const err = new Error(res.message || 'Import failed');
    (err as any).processedCount = res.processedCount ?? startIndex;
    throw err;
}

export async function spotifyImportStreaming(token: string, startIndex: number = 0, signal?: AbortSignal): Promise<{ matched: number; notFound: number }> {
    const res = await pyCall('spotify_import_streaming', { token, startIndex }, signal);
    if (res.status === 'ok') return { matched: res.matched, notFound: res.notFound };
    const err = new Error(res.message || 'Import failed');
    (err as any).processedCount = res.processedCount ?? startIndex;
    throw err;
}
