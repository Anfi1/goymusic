import { useQuery } from '@tanstack/react-query';
import { useMemo, useCallback } from 'react';
import { getLibraryPlaylists, getUserInfo, YTMPlaylist, YTMUser } from '../api/yt';

/**
 * <summary>
 * Хук для доступа к библиотеке пользователя (плейлисты, профиль).
 * Использует React Query для кэширования и автоматического обновления.
 * </summary>
 */
export const useLibrary = (isAuthenticated: boolean) => {
  const playlistsQuery = useQuery({
    queryKey: ['library-playlists'],
    queryFn: getLibraryPlaylists,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000, // 5 минут
  });

  const userQuery = useQuery({
    queryKey: ['user-info'],
    queryFn: getUserInfo,
    enabled: isAuthenticated,
    staleTime: 30 * 60 * 1000, // 30 минут
  });

  // Мемоизируем списки, чтобы ссылки были стабильными
  const playlists = useMemo(() => playlistsQuery.data || [], [playlistsQuery.data]);
  
  const ownedPlaylists = useMemo(() => {
    // Фильтруем только те, в которые действительно можно добавлять треки
    return playlists.filter(p => p.can_add);
  }, [playlists]);

  const user = useMemo(() => userQuery.data || null, [userQuery.data]);

  const playlistsRefetch = playlistsQuery.refetch;
  const userRefetch = userQuery.refetch;

  const refetch = useCallback(() => {
    playlistsRefetch();
    userRefetch();
  }, [playlistsRefetch, userRefetch]);

  return useMemo(() => ({
    playlists,
    ownedPlaylists,
    user,
    isLoading: playlistsQuery.isLoading || userQuery.isLoading,
    refetch
  }), [playlists, ownedPlaylists, user, playlistsQuery.isLoading, userQuery.isLoading, refetch]);
};
