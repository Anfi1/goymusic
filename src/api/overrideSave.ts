import type { LocalOverride } from './localOverrides';
import type { YTMTrack } from './yt';

export type OverrideWithGainMeasured = LocalOverride & { gainMeasured?: boolean };

export interface DownloadDirectLoudnessResult {
  filename: string;
  gainDb?: unknown;
  gainMeasured?: unknown;
}

export interface BuildSavedStreamOverrideParams {
  track: Pick<YTMTrack, 'id' | 'source' | 'scUrl'>;
  cachedUrl: string;
  cachedLoudness?: number | null;
  storedLoudness?: number | null;
  downloadRes: DownloadDirectLoudnessResult;
  now?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function resolveMeasuredGain(
  rawGainDb: unknown,
  rawMeasured?: unknown
): { gainDb: number; gainMeasured: boolean } {
  const finite = isFiniteNumber(rawGainDb);
  const gainDb = finite ? rawGainDb : 0;
  const gainMeasured =
    typeof rawMeasured === 'boolean'
      ? rawMeasured && finite
      : finite && rawGainDb !== 0;
  return { gainDb, gainMeasured };
}

// stream.ts перекачивает пропавший локальный файл, если sourceType не 'local'/'youtube'.
// Для SoundCloud сохраняем постоянный permalink, а если его нет (или это временный CDN Yandex),
// помечаем как 'local', чтобы не пытаться перекачивать протухшую подписанную ссылку.
function resolveSavedStreamSource(
  track: Pick<YTMTrack, 'id' | 'source' | 'scUrl'>,
  cachedUrl: string
): { sourceType: LocalOverride['sourceType']; sourceUrl: string } {
  if (
    track.source === 'soundcloud' ||
    track.id.includes('soundcloud.com') ||
    cachedUrl.includes('soundcloud')
  ) {
    const scPermalink =
      track.scUrl?.trim() ||
      (track.id.includes('soundcloud.com') ? track.id.trim() : '');
    if (scPermalink) {
      return { sourceType: 'soundcloud', sourceUrl: scPermalink };
    }
    return { sourceType: 'local', sourceUrl: cachedUrl };
  }

  if (
    track.source === 'yandex' ||
    track.id.startsWith('yandex:') ||
    cachedUrl.includes('yandex.net') ||
    cachedUrl.includes('music.yandex')
  ) {
    return { sourceType: 'local', sourceUrl: cachedUrl };
  }

  return { sourceType: 'youtube', sourceUrl: cachedUrl };
}

// Для сохраненного потока приоритет у свежего замера скачанного файла,
// затем cached.loudness (YouTube), затем постоянный кеш громкости (SoundCloud).
export function buildSavedStreamOverride({
  track,
  cachedUrl,
  cachedLoudness,
  storedLoudness,
  downloadRes,
  now,
}: BuildSavedStreamOverrideParams): OverrideWithGainMeasured {
  const downloaded = resolveMeasuredGain(downloadRes.gainDb, downloadRes.gainMeasured);
  let gainDb = 0;
  let gainMeasured = false;

  if (downloaded.gainMeasured) {
    gainDb = downloaded.gainDb;
    gainMeasured = true;
  } else if (isFiniteNumber(cachedLoudness)) {
    gainDb = cachedLoudness;
    gainMeasured = true;
  } else if (isFiniteNumber(storedLoudness)) {
    gainDb = storedLoudness;
    gainMeasured = true;
  }

  const { sourceType, sourceUrl } = resolveSavedStreamSource(track, cachedUrl);

  return {
    videoId: track.id,
    filename: downloadRes.filename,
    sourceUrl,
    sourceType,
    gainDb,
    gainMeasured,
    addedAt: now ?? Date.now(),
  };
}
