import React, { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getExploreReleases, getAlbum, getPlaylistTracks } from '../../api/yt';
import { player } from '../../api/player';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { Sparkles, RefreshCw } from 'lucide-react';
import { isYandexEnabled, getYandexNewReleases, getYandexAlbumTracks } from '../../api/yandex';
import styles from './NewReleasesView.module.css';

interface NewReleasesViewProps {
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onSelectArtist: (id: string) => void;
}

export const NewReleasesView: React.FC<NewReleasesViewProps> = ({ 
  onSelectAlbum, onSelectPlaylist, onSelectArtist 
}) => {
  const [yandexMode, setYandexMode] = useState(false);

  const { data: rawSections, isLoading, isFetching } = useQuery({
    queryKey: ['new-releases'],
    queryFn: getExploreReleases,
    staleTime: 30 * 60 * 1000,
    enabled: !yandexMode,
  });

  const { data: yandexReleases, isLoading: yandexLoading } = useQuery({
    queryKey: ['yandex-new-releases'],
    queryFn: getYandexNewReleases,
    staleTime: 30 * 60 * 1000,
    enabled: yandexMode,
  });

  const playYandexAlbum = useCallback(async (albumId: string) => {
    const detail = await getYandexAlbumTracks(albumId);
    if (detail?.tracks?.length) await player.playTrackList(detail.tracks, 0, albumId, 'album');
  }, []);

  // Move the first section to the bottom as requested (YouTube's first section is usually mixed playlists)
  const sections = React.useMemo(() => {
    if (!rawSections || rawSections.length <= 1) return rawSections;
    const [first, ...rest] = rawSections;
    return [...rest, first];
  }, [rawSections]);

  const handleItemClick = useCallback((item: any) => {
    const type = item.type?.toLowerCase();
    if (type === 'artist') onSelectArtist(item.id);
    else if (type === 'album') onSelectAlbum(item.browseId || item.id);
    else if (type === 'playlist') onSelectPlaylist(item.playlistId || item.id, item.title);
    else if (type === 'song') {
      if (item.videoId) {
        player.playSingle({
          id: item.videoId,
          title: item.title,
          artists: item.artists,
          artistIds: item.artistIds,
          thumbUrl: item.thumbUrl,
          album: '',
          duration: ''
        } as any);
      } else if (item.browseId) {
        onSelectAlbum(item.browseId);
      }
    }
  }, [onSelectArtist, onSelectAlbum, onSelectPlaylist]);

  const handlePlayClick = useCallback(async (item: any) => {
    const type = item.type?.toLowerCase();
    if (type === 'song' && item.videoId) {
      await player.playSingle({
        id: item.videoId,
        title: item.title,
        artists: item.artists,
        artistIds: item.artistIds,
        thumbUrl: item.thumbUrl,
        album: '',
        duration: ''
      } as any);
    } else if (type === 'album' && (item.playlistId || item.browseId)) {
      const targetId = item.browseId || item.playlistId;
      const albumData = await getAlbum(targetId);
      if (albumData?.tracks?.length) {
        await player.playTrackList(albumData.tracks, 0, targetId, 'album', albumData.audioPlaylistId);
      }
    } else if (type === 'playlist' && item.playlistId) {
      const result = await getPlaylistTracks(item.playlistId);
      if (result.tracks?.length) {
        await player.playTrackList(result.tracks, 0, item.playlistId, 'playlist');
      }
    }
  }, []);

  const yandexToggle = isYandexEnabled() ? (
    <button
      onClick={() => setYandexMode(v => !v)}
      style={{
        padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
        fontSize: 12, fontWeight: 700, marginLeft: 'auto',
        background: yandexMode ? '#ffcc00' : 'rgba(255,255,255,0.08)',
        color: yandexMode ? '#1a1a1a' : 'var(--text-main, #cdd6f4)',
      }}
      title={yandexMode ? 'Показать новинки YouTube Music' : 'Показать новинки Yandex Music'}
    >
      {yandexMode ? 'YouTube Music' : 'Yandex Music'}
    </button>
  ) : null;

  const header = (
    <div className={styles.header}>
      <div className={styles.titleInfo}>
        <div className={styles.titleWrapper}>
          <Sparkles size={28} className={styles.icon} />
          <h1>New Releases</h1>
        </div>
        {!yandexMode && isFetching && (
          <div className={styles.updatingBadge}>
            <RefreshCw size={10} className="animate-spin" />
            Updating
          </div>
        )}
      </div>
      {yandexToggle}
    </div>
  );

  if (yandexMode) {
    return (
      <div className={styles.container}>
        {header}
        <div className={styles.section}>
          <div className={styles.grid}>
            {yandexLoading ? (
              Array.from({ length: 12 }).map((_, i) => <MediaCardSkeleton key={i} />)
            ) : (yandexReleases || []).map((a) => (
              <MediaCard
                key={a.albumId}
                id={a.albumId}
                title={a.title}
                thumbUrl={a.thumbUrl}
                artists={a.artist ? [a.artist] : []}
                year={a.year ? String(a.year) : undefined}
                type="album"
                onClick={() => playYandexAlbum(a.albumId)}
                onPlayClick={() => playYandexAlbum(a.albumId)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.container}>
        {header}
        <div className={styles.section}>
          <div className={styles.grid}>
            {Array.from({ length: 12 }).map((_, i) => (
              <MediaCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {header}

      {sections?.map((section: any, sIdx: number) => (
        <div key={sIdx} className={styles.section}>
          <div className={styles.grid}>
            {section.items.map((item: any, iIdx: number) => (
              <MediaCard
                key={`${item.id}-${iIdx}`}
                {...item}
                onClick={() => handleItemClick(item)}
                onPlayClick={() => handlePlayClick(item)}
                onArtistClick={onSelectArtist}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
