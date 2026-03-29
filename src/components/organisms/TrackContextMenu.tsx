import React, { useState, useImperativeHandle, forwardRef, useMemo, useCallback } from 'react';
import { ContextMenu } from '../molecules/ContextMenu';
import { useTrackMenu } from '../../hooks/useTrackMenu';
import { YTMTrack } from '../../api/yt';
import { TrackOverrideDialog } from './TrackOverrideDialog';

export interface TrackContextMenuHandle {
  /** Открыть меню в координатах события для указанного трека */
  open: (e: React.MouseEvent | MouseEvent, track: YTMTrack, options?: any) => void;
  /** Закрыть меню */
  close: () => void;
}

interface TrackContextMenuProps {
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
  onRemoveFromQueue?: (index: number) => void;
  onPlayFromQueue?: (index: number) => void;
  playlistId?: string;
  isOwnedPlaylist?: boolean;
}

/**
 * <summary>
 * Изолированный компонент контекстного меню трека.
 * Позволяет открывать меню без ререндера родительского списка.
 * </summary>
 */
export const TrackContextMenu = forwardRef<TrackContextMenuHandle, TrackContextMenuProps>((props, ref) => {
  const {
    onSelectArtist, onSelectAlbum, onSelectPlaylist,
    onRemoveFromQueue, onPlayFromQueue, playlistId, isOwnedPlaylist
  } = props;

  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    track: YTMTrack;
    runtimeOptions: any;
  } | null>(null);

  const [overrideTrack, setOverrideTrack] = useState<YTMTrack | null>(null);

  const handleClose = useCallback(() => {
    setMenuState(null);
  }, []);

  useImperativeHandle(ref, () => ({
    open: (e, track, options = {}) => {
      setMenuState({
        x: e.clientX,
        y: e.clientY,
        track,
        runtimeOptions: options
      });
    },
    close: handleClose
  }));

  const menuOptions = useMemo(() => {
    if (!menuState) return { track: {} as YTMTrack };
    return {
      track: menuState.track,
      onSelectArtist,
      onSelectAlbum,
      onSelectPlaylist,
      onRemoveFromQueue,
      onPlayFromQueue,
      onOpenOverrideDialog: setOverrideTrack,
      playlistId: menuState.runtimeOptions.playlistId || playlistId,
      isOwnedPlaylist: menuState.runtimeOptions.isOwnedPlaylist ?? isOwnedPlaylist,
      ...menuState.runtimeOptions
    };
  }, [menuState, onSelectArtist, onSelectAlbum, onSelectPlaylist, onRemoveFromQueue, onPlayFromQueue, playlistId, isOwnedPlaylist]);

  const items = useTrackMenu(menuOptions);

  return (
    <>
      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={items}
          onClose={handleClose}
        />
      )}
      {overrideTrack && (
        <TrackOverrideDialog
          track={overrideTrack}
          isOpen={!!overrideTrack}
          onClose={() => setOverrideTrack(null)}
        />
      )}
    </>
  );
});

TrackContextMenu.displayName = 'TrackContextMenu';
