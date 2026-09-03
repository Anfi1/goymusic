import React, { useEffect, useState, useCallback } from 'react';
import { player } from '../../api/player';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { AudioLines, Sparkles, Library, Heart, Disc, ListMusic } from 'lucide-react';
import {
  getYandexWaveTracks, getYandexNewReleases, getYandexAlbumTracks, YandexAlbumResult,
  getYandexPlaylists, getYandexPlaylistTracks, YandexPlaylistResult,
  getCachedYandexLikedTracks, syncYandexLikedTracks,
  yandexAlbumRouteId, yandexPlaylistRouteId,
  getYandexHomeGenres, getYandexNewPlaylists, YandexHomeGenre,
} from '../../api/yandex';
import { YTMTrack } from '../../api/yt';
import styles from './HomeView.module.css';

interface ShelfProps<T> {
  title: string;
  items: T[] | null;
  emptyText: string;
  renderCard: (item: T) => React.ReactNode;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}

// Общая полоса карточек: скелетон / пусто / грид -- одна реализация на все секции.
function Shelf<T>({ title, items, emptyText, renderCard, icon: Icon }: ShelfProps<T>) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitleWrapper}>
          {Icon && <Icon size={20} className={styles.sectionIcon} />}
          <span style={{ marginLeft: 12, fontWeight: 700, fontSize: 20 }}>{title}</span>
        </div>
      </div>
      {items === null ? (
        <div className={styles.horizontalScroll}>
          {Array.from({ length: 6 }).map((_, i) => <MediaCardSkeleton key={i} className={styles.card} />)}
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: '8px 12px', opacity: 0.6 }}>{emptyText}</div>
      ) : (
        <div className={styles.horizontalScroll}>
          {items.map(renderCard)}
        </div>
      )}
    </section>
  );
}

// Лёгкая «Главная» на данных Yandex Music: волна, новинки, плейлисты, лайки.
// Отдельный компонент, а не ветка внутри HomeView — чтобы не путать его
// инфинит-скролл/пагинацию YT-ленты.
export const YandexHomeView: React.FC<{
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onSelectArtist: (id: string) => void;
  onSelectGenre: (genreId: string, title: string) => void;
}> = ({ onSelectAlbum, onSelectPlaylist, onSelectArtist, onSelectGenre }) => {
  const [waveTracks, setWaveTracks] = useState<YTMTrack[] | null>(null);
  const [releases, setReleases] = useState<YandexAlbumResult[] | null>(null);
  const [playlists, setPlaylists] = useState<YandexPlaylistResult[] | null>(null);
  const [likedTracks, setLikedTracks] = useState<YTMTrack[] | null>(null);
  const [genres, setGenres] = useState<YandexHomeGenre[] | null>(null);
  const [newPlaylists, setNewPlaylists] = useState<YandexPlaylistResult[] | null>(null);

  useEffect(() => {
    let alive = true;
    getYandexWaveTracks().then(t => { if (alive) setWaveTracks(t); });
    getYandexNewReleases().then(r => { if (alive) setReleases(r); });
    getYandexPlaylists().then(p => { if (alive) setPlaylists(p); });
    getCachedYandexLikedTracks().then(t => { if (alive && t.length > 0) setLikedTracks(t); });
    syncYandexLikedTracks().then(async () => {
      const fresh = await getCachedYandexLikedTracks();
      if (alive) setLikedTracks(fresh);
    });
    getYandexHomeGenres().then(g => { if (alive) setGenres(g); });
    getYandexNewPlaylists().then(p => { if (alive) setNewPlaylists(p); });
    return () => { alive = false; };
  }, []);

  const playWave = useCallback(() => {
    if (waveTracks && waveTracks.length > 0) player.playTrackList(waveTracks, 0, 'yandex-wave');
  }, [waveTracks]);

  const playAlbum = useCallback(async (albumId: string) => {
    const detail = await getYandexAlbumTracks(albumId);
    if (detail?.tracks?.length) player.playTrackList(detail.tracks, 0, albumId, 'album');
  }, []);

  const playPlaylist = useCallback(async (kind: string) => {
    const detail = await getYandexPlaylistTracks(kind);
    if (detail?.tracks?.length) player.playTrackList(detail.tracks, 0, `yandex-playlist-${kind}`, 'playlist');
  }, []);

  const playLiked = useCallback((index: number) => {
    if (likedTracks && likedTracks.length > 0) player.playTrackList(likedTracks, index, 'yandex-likes');
  }, [likedTracks]);

  const playNewPlaylist = useCallback(async (id: string) => {
    const [, ownerId, kind] = id.split(':');
    const detail = await getYandexPlaylistTracks(kind, ownerId);
    if (detail?.tracks?.length) player.playTrackList(detail.tracks, 0, id, 'playlist');
  }, []);

  return (
    <div className={styles.container}>
      <Shelf
        title="Моя волна"
        icon={AudioLines}
        items={waveTracks?.slice(0, 20) ?? waveTracks}
        emptyText="Не удалось загрузить волну."
        renderCard={(t) => (
          <MediaCard key={t.id} id={t.id} title={t.title} thumbUrl={t.thumbUrl} artists={t.artists}
            artistIds={t.artistIds} onArtistClick={onSelectArtist}
            type="song" className={styles.card} onClick={playWave} onPlayClick={playWave} />
        )}
      />
      <Shelf
        title="Новинки"
        icon={Sparkles}
        items={releases}
        emptyText="Не удалось загрузить новинки."
        renderCard={(a) => (
          <MediaCard key={a.albumId} id={a.albumId} title={a.title} thumbUrl={a.thumbUrl}
            artists={a.artist ? [a.artist] : []} year={a.year ? String(a.year) : undefined}
            artistIds={a.artistIds?.map((id: string) => `yandex:${id}`)} onArtistClick={onSelectArtist}
            type="album" className={styles.card} onClick={() => onSelectAlbum(yandexAlbumRouteId(a.albumId))} onPlayClick={() => playAlbum(a.albumId)} />
        )}
      />
      <Shelf
        title="Мои плейлисты"
        icon={Library}
        items={playlists}
        emptyText="Плейлистов пока нет."
        renderCard={(pl) => (
          <MediaCard key={pl.id} id={pl.id} title={pl.title} thumbUrl={pl.thumbUrl}
            description={pl.trackCount ? `${pl.trackCount} tracks` : undefined}
            type="playlist" className={styles.card} onClick={() => onSelectPlaylist(yandexPlaylistRouteId('', pl.id), pl.title)} onPlayClick={() => playPlaylist(pl.id)} />
        )}
      />
      <Shelf
        title="Любимые треки"
        icon={Heart}
        items={likedTracks?.slice(0, 20) ?? likedTracks}
        emptyText="Лайков пока нет."
        renderCard={(t) => {
          const idx = (likedTracks || []).findIndex(lt => lt.id === t.id);
          return (
            <MediaCard key={t.id} id={t.id} title={t.title} thumbUrl={t.thumbUrl} artists={t.artists}
              artistIds={t.artistIds} onArtistClick={onSelectArtist}
              type="song" className={styles.card} onClick={() => playLiked(idx)} onPlayClick={() => playLiked(idx)} />
          );
        }}
      />
      {(genres === null || genres.length > 0) && (
        <Shelf
          title="Жанры и настроения"
          icon={Disc}
          items={genres}
          emptyText=""
          renderCard={(g) => (
            <MediaCard key={g.id} id={g.id} title={g.title} thumbUrl={g.thumbUrl}
              type="playlist" className={styles.card} onClick={() => onSelectGenre(g.id, g.title)} />
          )}
        />
      )}
      {(newPlaylists === null || newPlaylists.length > 0) && (
        <Shelf
          title="Новые плейлисты"
          icon={ListMusic}
          items={newPlaylists}
          emptyText=""
          renderCard={(pl) => (
            <MediaCard key={pl.id} id={pl.id} title={pl.title} thumbUrl={pl.thumbUrl}
              type="playlist" className={styles.card} onClick={() => onSelectPlaylist(pl.id, pl.title)} onPlayClick={() => playNewPlaylist(pl.id)} />
          )}
        />
      )}
    </div>
  );
};
