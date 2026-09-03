import { streamCache, CacheEntry } from './cache';
import { getOverride, setOverride } from './localOverrides';
import { createCallId } from './callId';

/**
 * Карта активных запросов к Python. 
 * Позволяет избежать дублирования запросов для одного и того же видео (Request Collapsing).
 */
const pendingRequests = new Map<string, Promise<CacheEntry | null>>();

/**
 * Реестр SoundCloud-треков: id трека -> resolvable SC permalink URL.
 * Заполняется при создании SC-результатов поиска и перед воспроизведением.
 * По наличию id в реестре stream.ts понимает, что стрим надо тянуть через get_preview_url.
 */
const scRegistry = new Map<string, string>();

export function registerSoundCloudTrack(id: string, scUrl: string) {
    if (id && scUrl) scRegistry.set(id, scUrl);
}

/**
 * Реестр Yandex-треков: id трека -> yandexId. Прямая ссылка на mp3 живёт ~60с,
 * поэтому в отличие от SC/YT кэш стрима для Yandex почти всегда будет протухшим --
 * это ожидаемо, get_stream_url-эквивалент (yandex_stream_url) запрашивается заново.
 */
const yandexRegistry = new Map<string, string>();

/**
 * Гейн нормализации из Track.normalization (см. python: yandex_track_dict) -- Яндекс
 * отдаёт его прямо в метаданных трека, как loudnessDb у YouTube. Отдельная карта,
 * т.к. loudness живёт на объекте трека, а fetchYandexStream знает только id/yandexId.
 */
const yandexLoudnessRegistry = new Map<string, number>();

export function registerYandexTrack(id: string, yandexId: string, loudness?: number) {
    if (id && yandexId) yandexRegistry.set(id, yandexId);
    if (id && loudness != null) yandexLoudnessRegistry.set(id, loudness);
}

async function fetchYandexStream(id: string, yandexId: string): Promise<CacheEntry | null> {
    if (pendingRequests.has(id)) {
        return pendingRequests.get(id)!;
    }
    const callId = createCallId();
    const requestPromise = (async () => {
        try {
            const res = await (window as any).bridge.pyCall('yandex_stream_url', { yandexId, callId });
            if (res.status === 'ok' && res.url) {
                const expires = res.expires ?? (Math.floor(Date.now() / 1000) + 45);
                // Известный из метаданных гейн (см. registerYandexTrack) экономит ffmpeg-замер
                // и убирает гонку с истечением ссылки за ~60с; если его нет -- null, фронт
                // домеряет громкость сам через ensureLoudness, как для SC.
                const loudness = yandexLoudnessRegistry.get(id) ?? null;
                await streamCache.set(id, res.url, expires, loudness);
                console.log(`[stream] Yandex fetch: ${id} -> Done (loudness: ${loudness})`);
                return { url: res.url, expires, loudness };
            }
            console.warn(`[stream] Yandex fetch: ${id} -> Failed`, res);
        } catch (e) {
            console.error(`[stream] Yandex fetch: ${id} -> Error`, e);
        } finally {
            pendingRequests.delete(id);
        }
        return null;
    })();
    pendingRequests.set(id, requestPromise);
    return requestPromise;
}

/**
 * Резолв играбельного стрима SoundCloud через Python get_preview_url.
 * Кэшируется по id трека так же, как YouTube-стримы.
 */
async function fetchSoundCloudStream(id: string, scUrl: string): Promise<CacheEntry | null> {
    if (pendingRequests.has(id)) {
        return pendingRequests.get(id)!;
    }
    const callId = createCallId();
    const requestPromise = (async () => {
        try {
            const res = await (window as any).bridge.pyCall('get_preview_url', { url: scUrl, callId });
            if (res.status === 'ok' && res.streamUrl) {
                const expires = getExpirationFromUrl(res.streamUrl);
                const loudness = res.loudness ?? null;
                await streamCache.set(id, res.streamUrl, expires, loudness);
                console.log(`[stream] SoundCloud fetch: ${id} -> Done (loudness: ${loudness})`);
                return { url: res.streamUrl, expires, loudness };
            }
            console.warn(`[stream] SoundCloud fetch: ${id} -> Failed`, res);
        } catch (e) {
            console.error(`[stream] SoundCloud fetch: ${id} -> Error`, e);
        } finally {
            pendingRequests.delete(id);
        }
        return null;
    })();
    pendingRequests.set(id, requestPromise);
    return requestPromise;
}

const pendingLoudness = new Map<string, Promise<number | null>>();

/**
 * Громкость для стримов, у которых источник её не отдал: SoundCloud (всегда) и редкие
 * YouTube-треки, для которых YouTube не отдал loudnessDb. Меряется в питоне через
 * ffmpeg loudnorm уже ПОСЛЕ старта воспроизведения, трек этого не ждёт. Кэш по id, без срока
 * годности -- переизмерять при каждом протухании ссылки незачем.
 */
export async function ensureLoudness(id: string, url: string): Promise<number | null> {
    await streamCache.init();
    const cached = await streamCache.getLoudness(id);
    if (cached !== null) return cached;
    if (pendingLoudness.has(id)) return pendingLoudness.get(id)!;

    const requestPromise = (async () => {
        try {
            const res = await (window as any).bridge.pyCall('measure_loudness', { url, callId: createCallId() });
            if (res.status === 'ok' && typeof res.loudness === 'number') {
                await streamCache.setLoudness(id, res.loudness);
                console.log(`[stream] Loudness measured: ${id} -> ${res.loudness.toFixed(2)}dB (peak ${res.truePeak})`);
                return res.loudness as number;
            }
            console.warn(`[stream] Loudness measure failed: ${id}`, res);
        } catch (e) {
            console.error(`[stream] Loudness measure error: ${id}`, e);
        } finally {
            pendingLoudness.delete(id);
        }
        return null;
    })();

    pendingLoudness.set(id, requestPromise);
    return requestPromise;
}

/**
 * Контроллер для отмены текущего высокоприоритетного запроса (при быстром переключении).
 */
let currentAbortController: AbortController | null = null;

/**
 * Таймер для дебаунса префетча при наведении мышкой.
 */
let prefetchTimeout: any = null;

/**
 * Извлекает UNIX-время истечения ссылки из URL.
 * YouTube: параметр expire.
 * SoundCloud (CloudFront): декодируем Policy (base64 → JSON → DateLessThan).
 */
export function getExpirationFromUrl(url: string): number {
    try {
        const urlObj = new URL(url);
        const expire = urlObj.searchParams.get('expire');
        if (expire) return parseInt(expire, 10);

        const policy = urlObj.searchParams.get('Policy');
        if (policy) {
            try {
                const decoded = atob(policy.replace(/-/g, '+').replace(/_/g, '/'));
                const parsed = JSON.parse(decoded);
                const epochTime = parsed?.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];
                if (epochTime) return epochTime;
            } catch {}
        }

        return Math.floor(Date.now() / 1000) + 600;
    } catch {
        return Math.floor(Date.now() / 1000) + 600;
    }
}

/**
 * Выполняет реальный вызов к Python-мосту с защитой от дублей и поддержкой отмены.
 */
async function fetchStreamFromPython(videoId: string, signal?: AbortSignal, expectedSec?: number): Promise<CacheEntry | null> {
    // SoundCloud/URL-shaped ids must never reach the YouTube get_stream_url path
    if (videoId.includes('://')) return null;

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
            const res = await (window as any).bridge.pyCall('get_stream_url', { videoId, callId, expectedDuration: expectedSec });
            if (res.status === 'ok' && res.url) {
                const expires = getExpirationFromUrl(res.url);
                const loudness = res.loudness ?? null;
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
export async function getStreamUrl(videoId: string, forceBypassCache: boolean = false, expectedSec?: number): Promise<CacheEntry | null> {
    await streamCache.init();

    // Приоритет 1: локальный файл — проверяем ПЕРВЫМ делом
    const override = await getOverride(videoId);
    if (override) {
        const fileExists = await (window as any).bridge.songFileExists(override.filename);
        if (fileExists) {
            const fileUrl = await (window as any).bridge.getSongFileUrl(override.filename);
            console.log(`[stream] SOURCE: local (${videoId}): ${override.filename}`);
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

    // Приоритет 2: Yandex Music (прямая ссылка живёт ~60с -- кэш почти всегда мимо,
    // но проверяем на случай мгновенного повторного вызова в пределах этого окна).
    const yandexId = yandexRegistry.get(videoId);
    if (yandexId) {
        if (!forceBypassCache) {
            const cached = await streamCache.get(videoId);
            if (cached) {
                console.log(`[stream] SOURCE: yandex-cache (${videoId})`);
                return cached;
            }
        } else {
            await streamCache.delete(videoId);
        }
        console.log(`[stream] SOURCE: yandex-stream (${videoId})`);
        return fetchYandexStream(videoId, yandexId);
    }

    // Приоритет 3: SoundCloud
    const scUrl = scRegistry.get(videoId);
    if (scUrl) {
        if (!forceBypassCache) {
            const cached = await streamCache.get(videoId);
            if (cached) {
                console.log(`[stream] SOURCE: soundcloud-cache (${videoId})`);
                return cached;
            }
        } else {
            await streamCache.delete(videoId);
        }
        console.log(`[stream] SOURCE: soundcloud-stream (${videoId}): ${scUrl}`);
        return fetchSoundCloudStream(videoId, scUrl);
    }

    if (!forceBypassCache) {
        const cached = await streamCache.get(videoId);
        if (cached) {
            console.log(`[stream] SOURCE: youtube-cache (${videoId})`);
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

    console.log(`[stream] SOURCE: youtube-fetch (${videoId})`);
    const entry = await fetchStreamFromPython(videoId, currentAbortController.signal, expectedSec);
    if (entry) console.log(`[stream] SOURCE: youtube-stream (${videoId})`);
    
    return entry;
}

/**
 * Мгновенный префетч. Используется плеером для подгрузки очереди.
 */
export async function prefetchStreamUrl(videoId: string, expectedSec?: number) {
    await streamCache.init();

    // Yandex-ссылка живёт ~60с -- префетч заранее почти гарантированно протухнет
    // к моменту реального воспроизведения, поэтому просто ждём getStreamUrl() при play.
    if (yandexRegistry.has(videoId)) return;

    const scUrlPrefetch = scRegistry.get(videoId);
    if (scUrlPrefetch) {
        const isFreshSc = await streamCache.isFresh(videoId);
        if (!isFreshSc && !pendingRequests.has(videoId)) {
            fetchSoundCloudStream(videoId, scUrlPrefetch);
        }
        return;
    }

    const override = await getOverride(videoId);
    if (override) return;

    const isFresh = await streamCache.isFresh(videoId);
    const isPending = pendingRequests.has(videoId);

    if (isFresh || isPending) {
        return;
    }

    console.log(`[stream] Prefetch started: ${videoId}`);
    const entry = await fetchStreamFromPython(videoId, undefined, expectedSec);
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
