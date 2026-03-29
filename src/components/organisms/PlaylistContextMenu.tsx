import React, { forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { Pencil, Trash2, Play } from 'lucide-react';
import { ContextMenu, ContextMenuItem } from '../molecules/ContextMenu';
import { YTMPlaylist, deletePlaylist, editPlaylist } from '../../api/yt';
import { useToast } from '../atoms/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { InputDialog } from '../molecules/InputDialog';
import { ConfirmDialog } from '../molecules/ConfirmDialog';

interface PlaylistContextMenuProps {
  onSelect?: (playlist: YTMPlaylist) => void;
  onNavigateHome?: () => void;
}

export interface PlaylistContextMenuRef {
  /** Открыть меню в координатах события для указанного плейлиста */
  open: (e: React.MouseEvent | MouseEvent, playlist: YTMPlaylist) => void;
  /** Закрыть меню */
  close: () => void;
}

/**
 * <summary>
 * Контекстное меню для управления плейлистами (удаление, переименование).
 * </summary>
 */
export const PlaylistContextMenu = forwardRef<PlaylistContextMenuRef, PlaylistContextMenuProps>(({ onSelect, onNavigateHome }, ref) => {
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    playlist: YTMPlaylist;
  } | null>(null);

  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const handleClose = useCallback(() => {
    setMenuState(null);
  }, []);

  useImperativeHandle(ref, () => ({
    open: (e, playlist) => {
      setMenuState({
        x: e.clientX,
        y: e.clientY,
        playlist
      });
    },
    close: handleClose
  }));

  const handleRename = useCallback(async (newTitle: string) => {
    setIsRenameOpen(false);
    if (!menuState) return;
    const { playlist } = menuState;
    
    if (newTitle && newTitle !== playlist.title) {
      const success = await editPlaylist(playlist.id, { title: newTitle });
      if (success) {
        showToast('Playlist renamed', 'success');
        queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
      } else {
        showToast('Failed to rename playlist', 'error');
      }
    }
    handleClose();
  }, [menuState, showToast, queryClient, handleClose]);

  const handleDelete = useCallback(async () => {
    setIsDeleteOpen(false);
    if (!menuState) return;
    const { playlist } = menuState;
    
    const success = await deletePlaylist(playlist.id);
    if (success) {
      showToast('Playlist deleted', 'success');
      queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
      onNavigateHome?.();
    } else {
      showToast('Failed to delete playlist', 'error');
    }
    handleClose();
  }, [menuState, showToast, queryClient, handleClose, onNavigateHome]);

  if (!menuState && !isRenameOpen && !isDeleteOpen) return null;

  const menuItems: ContextMenuItem[] = menuState ? [
    {
      label: 'Play Now',
      icon: Play,
      onClick: () => {
        onSelect?.(menuState.playlist);
        handleClose();
      }
    },
    {
      label: 'Rename',
      icon: Pencil,
      onClick: () => setIsRenameOpen(true)
    },
    {
      label: 'Delete',
      icon: Trash2,
      isDanger: true,
      onClick: () => setIsDeleteOpen(true)
    }
  ] : [];

  return (
    <>
      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={menuItems}
          onClose={handleClose}
        />
      )}
      <InputDialog
        isOpen={isRenameOpen}
        title="Rename Playlist"
        defaultValue={menuState?.playlist.title}
        onConfirm={handleRename}
        onCancel={() => { setIsRenameOpen(false); handleClose(); }}
      />
      <ConfirmDialog
        isOpen={isDeleteOpen}
        title="Delete Playlist"
        message={`Are you sure you want to delete "${menuState?.playlist.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        isDanger={true}
        onConfirm={handleDelete}
        onCancel={() => { setIsDeleteOpen(false); handleClose(); }}
      />
    </>
  );
});

PlaylistContextMenu.displayName = 'PlaylistContextMenu';
