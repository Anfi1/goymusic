import { streamCache, CacheEntry } from './cache';
import { getOverride, setOverride } from './localOverrides';
import { createCallId } from './callId';

/**
 * Карта активных запросов к Python. 
 * Позволяет избежать дублирования запросов для одного и того же видео (Request Collapsing).
 */
const pendingRequests = new Map<string, Promise<CacheEntry | null>>();

/**
 * Контроллер для отмены текущего высокоприоритетного запроса (при быстром переключении).
 */
let currentAbortController: AbortController | null = null;

/**
 * Таймер для дебаунса префетча при наведении мышкой.
 */
let prefetchTimeout: any = null;

/**
 * Извлекает UNIX-время истечения ссылки из URL YouTube.
 */
export function getExpirationFromUrl(url: string): number {
    try {
        const urlObj = new URL(url);
        const expire = urlObj.searchParams.get('expire');
        return expire ? parseInt(expire, 10) : Math.floor(Date.now() / 1000) + 3600;
    } catch {
        return Math.floor(Date.now() / 1000) + 3600;
    }
}

/**
 * Выполняет реальный вызов к Python-мосту с защитой от дублей и поддержкой отмены.
 */
async function fetchStreamFromPython(videoId: string, signal?: AbortSignal): Promise<CacheEntry | null> {
    // Если запрос для этого видео уже идет — просто подписываемся на него
    if (pendingRequests.has(videoId)) {
        return pendingRequests.get(videoId)!;
    }

    const callId = createCallId();
    
    // Если передан сигнал отмены — связываем его с мостом
    if (signal) {
        if (signal.aborted) return null;
        signal.addEventListener('abort', () => {
            console.log(`[stream] Aborting Python call: ${videoId} (${callId})`);
            (window as any).bridge.pyCancel(callId);
        }, { once: true });
    }

    console.log(`[stream] Python fetch: ${videoId}`);
    const requestPromise = (async () => {
        try {
            const res = await (window as any).bridge.pyCall('get_stream_url', { videoId, callId });
            if (res.status === 'ok' && res.url) {
                const expires = getExpirationFromUrl(res.url);
                const loudness = res.loudness || 0;
                const watchtimeUrl = res.watchtimeUrl as string | undefined;
                await streamCache.set(videoId, res.url, expires, loudness, watchtimeUrl);
                console.log(`[stream] Python fetch: ${videoId} -> Done (loudness: ${loudness})`);
                return { url: res.url, expires, loudness, watchtimeUrl };
            } else {
                if (res.message !== 'Cancelled by client') {
                    console.warn(`[stream] Python fetch: ${videoId} -> Failed`, res);
                }
            }
        } catch (e) {
            console.error(`[stream] Python fetch: ${videoId} -> Error`, e);
        } finally {
            pendingRequests.delete(videoId);
        }
        return null;
    })();

    pendingRequests.set(videoId, requestPromise);
    return requestPromise;
}

/**
 * Прямой запрос URL. Сначала база, потом Python.
 * Применяется при нажатии кнопки Play.
 */
export async function getStreamUrl(videoId: string, forceBypassCache: boolean = false): Promise<CacheEntry | null> {
    await streamCache.init();

    const override = await getOverride(videoId);
    if (override) {
        const fileExists = await (window as any).bridge.songFileExists(override.filename);
        if (fileExists) {
            const fileUrl = await (window as any).bridge.getSongFileUrl(override.filename);
            console.log(`[stream] Local override for ${videoId}: ${override.filename}`);
            return { url: fileUrl, expires: 9999999999, loudness: override.gainDb };
        }
        console.warn(`[stream] Local file missing for ${videoId}, falling back to stream`);
        if (override.sourceType !== 'local' && override.sourceType !== 'youtube' && override.sourceUrl) {
            (async () => {
                try {
                    const songsPath = await (window as any).bridge.getSongsPath();
                    const res = await (window as any).bridge.pyCall('download_track', {
                        url: override.sourceUrl,
                        videoId: override.videoId,
                        songsPath,
                        callId: createCallId(),
                    });
                    if (res.status === 'ok') {
                        await setOverride({ ...override, filename: res.filename });
                        console.log(`[stream] Re-downloaded missing file for ${videoId}`);
                    }
                } catch (e) {
                    console.warn(`[stream] Re-download failed for ${videoId}:`, e);
                }
            })();
        }
    }

    if (!forceBypassCache) {
        const cached = await streamCache.get(videoId);
        if (cached) {
            console.log(`[stream] Instant cache hit for ${videoId} (loudness: ${cached.loudness})`);
            return cached;
        }
    } else {
        console.log(`[stream] Bypassing cache and clearing entry for ${videoId}`);
        await streamCache.delete(videoId);
    }

    // ОТМЕНА ПРЕДЫДУЩЕГО ЗАПРОСА
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();

    console.log(`[stream] High-priority fetch started: ${videoId}`);
    const entry = await fetchStreamFromPython(videoId, currentAbortController.signal);
    if (entry) console.log(`[stream] High-priority fetch finished: ${videoId}`);
    
    return entry;
}

/**
 * Мгновенный префетч. Используется плеером для подгрузки очереди.
 */
export async function prefetchStreamUrl(videoId: string) {
    await streamCache.init();

    const override = await getOverride(videoId);
    if (override) return;

    const isFresh = await streamCache.isFresh(videoId);
    const isPending = pendingRequests.has(videoId);

    if (isFresh || isPending) {
        return;
    }

    console.log(`[stream] Prefetch started: ${videoId}`);
    const entry = await fetchStreamFromPython(videoId);
    if (entry) {
        console.log(`[stream] Prefetch finished successfully: ${videoId}`);
    }
}

/**
 * Дебаунс-запрос префетча. Специально для ховера на карточки (150мс).
 */
export function requestPrefetch(videoId: string) {
    if (prefetchTimeout) clearTimeout(prefetchTimeout);

    prefetchTimeout = setTimeout(async () => {
        const override = await getOverride(videoId);
        if (!override) prefetchStreamUrl(videoId);
    }, 150);
}

/**
 * Полная отмена текущего дебаунс-запроса (при MouseLeave).
 */
export function cancelPrefetchRequest() {
    if (prefetchTimeout) {
        clearTimeout(prefetchTimeout);
        prefetchTimeout = null;
    }
}
