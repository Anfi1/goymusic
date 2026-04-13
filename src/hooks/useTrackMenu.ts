import { useMemo } from 'react';
import { Play, ListMusic, Plus, Trash2, PlusCircle, Radio, ListVideo, HardDriveDownload, Link } from 'lucide-react';
import { getTrackLink } from '../api/trackLink';
import { player } from '../api/player';
import { 
  addPlaylistItems, 
  removePlaylistItems, 
  createPlaylist,
  YTMTrack 
} from '../api/yt';
import { historyStore } from '../api/history';
import { useToast } from '../components/atoms/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { ContextMenuItem } from '../components/molecules/ContextMenu';
import { useLibrary } from './useLibrary';

interface UseTrackMenuOptions {
  track: YTMTrack;
  playlistId?: string;
  isOwnedPlaylist?: boolean;
  type?: 'queue' | 'suggested' | 'list';
  index?: number;
  timestamp?: number; // Added for history removal
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
  onRemoveFromQueue?: (index: number) => void;
  onPlayFromQueue?: (index: number) => void;
  onRemoveFromHistory?: (timestamp: number) => void;
  onOpenOverrideDialog?: (track: YTMTrack) => void;
}

/**
 * <summary>
 * Хук для создания стандартизированного контекстного меню трека.
 * Поддерживает "Добавить в плейлист", "Удалить из плейлиста", навигацию и управление очередью.
 * </summary>
 */
export const useTrackMenu = (options: UseTrackMenuOptions) => {
  const {
    track, playlistId, isOwnedPlaylist, type = 'list', index, timestamp,
    onSelectArtist, onSelectAlbum, onSelectPlaylist,
    onRemoveFromQueue, onPlayFromQueue, onRemoveFromHistory, onOpenOverrideDialog
  } = options;

  const { showToast } = useToast();
  const queryClient = useQueryClient();
  
  // Получаем плейлисты из кэша (синхронизировано с сайдбаром)
  const { ownedPlaylists, isLoading } = useLibrary(true);

  const menuItems = useMemo(() => {
    if (!track) return [];

    const items: ContextMenuItem[] = [];

    // 1. Управление воспроизведением
    if (type === 'queue' && index !== undefined) {
      items.push({
        label: 'Play Now', icon: Play,
        onClick: () => onPlayFromQueue?.(index)
      });
      items.push({
        label: 'Play Next', icon: ListVideo,
        onClick: () => {
          player.removeFromQueue(index);
          player.playNext(track);
        }
      });
    } else {
      items.push({
        label: 'Play Now', icon: Play,
        onClick: () => {
          if (track.id) player.playSingle(track);
        }
      });
      items.push({
        label: 'Play Next', icon: ListVideo,
        onClick: () => player.playNext(track)
      });
      items.push({
        label: 'Add to Queue', icon: PlusCircle,
        onClick: () => player.addToQueue(track)
      });
    }

    // Radio
    items.push({
      label: 'Start Radio', icon: Radio,
      onClick: () => player.startRadio(track)
    });

    // 2. Навигация
    items.push({
      label: 'Go to Artist', icon: ListMusic,
      onClick: () => {
        const artistId = track.artistIds?.[0];
        if (artistId) onSelectArtist?.(artistId);
      }
    });

    if (track.albumId) {
      items.push({
        label: 'Go to Album', icon: ListMusic,
        onClick: () => onSelectAlbum?.(track.albumId!)
      });
    }

    const tid = track.playlistId || track.audioPlaylistId;
    if (tid) {
      items.push({
        label: 'Go to Playlist', icon: ListMusic,
        onClick: () => onSelectPlaylist?.(tid, track.album || 'Playlist')
      });
    }

    // Copy Link
    if (track.id) {
      items.push({
        label: 'Copy Link',
        icon: Link,
        onClick: () => {
          navigator.clipboard.writeText(getTrackLink(track));
          showToast('Link copied!', 'success');
        }
      });
    }

    // 3. Управление плейлистами
    const playlistChildren: ContextMenuItem[] = [];
    
    // Плейлисты из библиотеки
    if (isLoading) {
      playlistChildren.push(...Array.from({ length: 3 }).map((_, i) => ({
        label: `loading-${i}`,
        isSkeleton: true
      })));
    } else {
      playlistChildren.push(...ownedPlaylists.map(p => ({
        label: p.title,
        onClick: async () => {
          const success = await addPlaylistItems(p.id, [track.id]);
          if (success) {
            showToast(`Added to ${p.title}`, 'success');
            
            // Оптимистичное обновление: если мы сейчас смотрим этот плейлист, добавляем трек в начало
            queryClient.setQueriesData({ queryKey: ['playlist-infinite', 'playlist', p.id] }, (old: any) => {
              if (!old || !old.pages || old.pages.length === 0) return old;
              
              const newPages = [...old.pages];
              const firstPage = newPages[0];
              
              // Предотвращаем дублирование в UI, если трек уже там был (хотя YT позволяет дубликаты)
              // Мы просто пушим его в начало текущего списка
              return {
                ...old,
                pages: [
                  {
                    ...firstPage,
                    tracks: [track, ...firstPage.tracks],
                    metadata: {
                      ...firstPage.metadata,
                      trackCount: (firstPage.metadata.trackCount || 0) + 1
                    }
                  },
                  ...newPages.slice(1)
                ]
              };
            });
          }
          else showToast('Failed to add to playlist', 'error');
        }
      })));
    }

    // Разделитель и кнопка создания (если не загрузка)
    if (!isLoading) {
      playlistChildren.push({
        label: 'Create New Playlist...',
        icon: Plus,
        onClick: async () => {
          const title = window.prompt('Enter playlist title:');
          if (title) {
            const newId = await createPlaylist(title, [track.id]);
            if (newId) {
              showToast(`Created "${title}" with this track`, 'success');
              queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
            } else {
              showToast('Failed to create playlist', 'error');
            }
          }
        }
      });
    }

    items.push({
      label: 'Add to Playlist',
      icon: Plus,
      children: playlistChildren
    });

    // 4. Локальный оверрайд
    if (track.id && onOpenOverrideDialog) {
      items.push({
        label: 'Find Alternative',
        icon: HardDriveDownload,
        onClick: () => onOpenOverrideDialog(track)
      });
    }

    // 5. Удаление (если это свой плейлист или очередь или ИСТОРИЯ)
    if (type === 'queue' && index !== undefined) {
      items.push({
        label: 'Remove from Queue', icon: Trash2,
        isDanger: true,
        onClick: () => onRemoveFromQueue?.(index)
      });
    } else if (isOwnedPlaylist && playlistId && track.setVideoId) {
      items.push({
        label: 'Remove from Playlist', icon: Trash2,
        isDanger: true,
        onClick: async () => {
          const success = await removePlaylistItems(playlistId, [{ videoId: track.id, setVideoId: track.setVideoId! }]);
          if (success) {
            showToast('Removed from playlist', 'success');
            // Удаляем из кэша текущей страницы
            queryClient.setQueriesData({ queryKey: ['playlist-infinite', 'playlist', playlistId] }, (old: any) => {
              if (!old || !old.pages) return old;
              return {
                ...old,
                pages: old.pages.map((page: any) => ({
                  ...page,
                  tracks: page.tracks.filter((t: YTMTrack) => t.setVideoId !== track.setVideoId),
                  metadata: {
                    ...page.metadata,
                    trackCount: Math.max(0, (page.metadata.trackCount || 0) - 1)
                  }
                }))
              };
            });
          } else {
            showToast('Failed to remove track', 'error');
          }
        }
      });
    }

    if (timestamp !== undefined) {
      items.push({
        label: 'Remove from History', icon: Trash2,
        isDanger: true,
        onClick: async () => {
          await historyStore.deleteEntry(timestamp);
          showToast('Removed from history', 'success');
          onRemoveFromHistory?.(timestamp);
        }
      });
    }

    return items;
  }, [track, ownedPlaylists, isLoading, type, index, timestamp, playlistId, isOwnedPlaylist, onPlayFromQueue, onRemoveFromQueue, onRemoveFromHistory, onOpenOverrideDialog, onSelectArtist, onSelectAlbum, onSelectPlaylist, queryClient, showToast]);

  return menuItems;
};
