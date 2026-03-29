import React, { useState, useRef, useEffect, memo, useCallback } from 'react';
import { Settings, LogOut, PanelLeftClose, PanelLeftOpen, User as UserIcon, ChevronDown, Music, Plus, History, Home, Heart, Search, Sparkles, Radio } from 'lucide-react';
import { NavLink } from '../molecules/NavLink';
import { IconButton } from '../atoms/IconButton';
import { YTMPlaylist, YTMUser, createPlaylist } from '../../api/yt';
import { player } from '../../api/player';
import { ActiveView } from '../../types';
import { Skeleton } from '../atoms/Skeleton';
import { LazyImage } from '../atoms/LazyImage';
import { useToast } from '../atoms/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { PlaylistContextMenu, PlaylistContextMenuRef } from './PlaylistContextMenu';
import { InputDialog } from '../molecules/InputDialog';
import sidebarStyles from './Sidebar.module.css';

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  playlists?: YTMPlaylist[];
  activePlaylistId?: string | null;
  onSelectView?: (view: ActiveView) => void;
  isAuthenticated?: boolean;
  isInitializing?: boolean;
  onLogout?: () => void;
  user?: YTMUser | null;
  className?: string;
  activeViewType?: string;
}

const SidebarHeader = memo(({ 
  collapsed, 
  onToggleCollapse, 
  onSelectView,
  activeViewType
}: { 
  collapsed: boolean, 
  onToggleCollapse?: () => void, 
  onSelectView?: (view: ActiveView) => void,
  activeViewType?: string
}) => {
  const [clickCount, setClickCount] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleLogoClick = useCallback(() => {
    console.log(`[easter-egg] Click on logo. View: ${activeViewType}, Count: ${clickCount + 1}`);

    if (activeViewType === 'home') {
      const nextCount = clickCount + 1;
      
      if (nextCount >= 4) {
        console.log('[easter-egg] 🚀 ACTIVATED!');
        
        if (!audioRef.current) {
          audioRef.current = new Audio('https://us-tuna-sounds-files.voicemod.net/d991f515-a251-4ab6-b4de-b75c566127f9-1659582305102.mp3');
        }
        
        const audio = audioRef.current;
        audio.volume = player.volume / 100;

        const startPlayback = () => {
          const duration = audio.duration || 10;
          const startTime = Math.random() * Math.max(0, duration - 3.5);
          audio.currentTime = startTime;
          audio.play().catch(e => console.error('[easter-egg] Playback failed:', e));

          if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = setTimeout(() => {
            audio.pause();
          }, 3500);
        };

        if (audio.readyState >= 1) {
          startPlayback();
        } else {
          audio.load();
          audio.onloadedmetadata = startPlayback;
        }

        setClickCount(0);
      } else {
        setClickCount(nextCount);
      }

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setClickCount(0), 1000);
    }

    onSelectView?.({ type: 'home' });
  }, [onSelectView, activeViewType, clickCount]);

  return (
    <div className={sidebarStyles.header}>
      <IconButton
        icon={collapsed ? PanelLeftOpen : PanelLeftClose}
        size={32}
        iconSize={18}
        onClick={onToggleCollapse}
        className={sidebarStyles.toggleBtn}
        title={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
      />
      {!collapsed && (
        <h2 className={sidebarStyles.logo} onClick={handleLogoClick} style={{ cursor: 'pointer' }}>GoyMusic</h2>
      )}
    </div>
  );
});

const UserProfileSection = memo(({ 
  user, 
  collapsed, 
  onSelectView, 
  onLogout 
}: { 
  user?: YTMUser | null, 
  collapsed: boolean, 
  onSelectView?: (view: ActiveView) => void, 
  onLogout?: () => void 
}) => {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={`${sidebarStyles.userProfile} ${collapsed ? sidebarStyles.userProfileCollapsed : ''}`} ref={userMenuRef}>
      <div 
        className={sidebarStyles.userTrigger}
        onClick={() => setShowUserMenu(!showUserMenu)}
      >
        {user?.thumbUrl ? (
          <LazyImage 
            src={user.thumbUrl} 
            alt="Avatar" 
            className={sidebarStyles.avatar}
          />
        ) : (
          <div className={sidebarStyles.avatarPlaceholder}>
            <UserIcon size={16} />
          </div>
        )}
        {!collapsed && (
          <>
            <span className={sidebarStyles.userName}>{user?.name || 'Account'}</span>
            <ChevronDown size={14} className={`${sidebarStyles.chevron} ${showUserMenu ? sidebarStyles.chevronOpen : ''}`} />
          </>
        )}
      </div>

      {showUserMenu && (
        <div className={`${sidebarStyles.userMenu} ${collapsed ? sidebarStyles.userMenuCollapsed : ''}`}>
          <button 
            className={sidebarStyles.menuItem} 
            onClick={() => {
              onSelectView?.({ type: 'settings' });
              setShowUserMenu(false);
            }}
          >
            <Settings size={14} />
            Settings
          </button>
          <div className={sidebarStyles.menuDivider} />
          <button onClick={onLogout} className={`${sidebarStyles.menuItem} ${sidebarStyles.logoutBtn}`}>
            <LogOut size={14} />
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
});

const PlaylistItem = memo(({ 
  playlist, 
  isActive, 
  collapsed, 
  onSelectView,
  onContextMenu
}: { 
  playlist: YTMPlaylist, 
  isActive: boolean, 
  collapsed: boolean, 
  onSelectView?: (view: ActiveView) => void,
  onContextMenu?: (e: React.MouseEvent, playlist: YTMPlaylist) => void
}) => {
  const handleClick = useCallback(() => {
    onSelectView?.({ type: 'playlist', playlistId: playlist.id, playlistTitle: playlist.title });
  }, [playlist.id, playlist.title, onSelectView]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (playlist.owned && playlist.id !== 'LM' && !playlist.id.startsWith('LRYR')) {
      onContextMenu?.(e, playlist);
    }
  }, [onContextMenu, playlist]);

  return (
    <div onContextMenu={handleContextMenu}>
      <NavLink
        icon={Music}
        label={collapsed ? '' : playlist.title}
        active={isActive}
        onClick={handleClick}
        tooltip={collapsed ? playlist.title : undefined}
      />
    </div>
  );
});

const PlaylistList = memo(({ 
  playlists, 
  activePlaylistId, 
  collapsed, 
  isInitializing, 
  onSelectView,
  onContextMenu
}: { 
  playlists: YTMPlaylist[], 
  activePlaylistId?: string | null, 
  collapsed: boolean, 
  isInitializing: boolean, 
  onSelectView?: (view: ActiveView) => void,
  onContextMenu?: (e: React.MouseEvent, playlist: YTMPlaylist) => void
}) => {
  if (isInitializing) {
    return (
      <>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ padding: '0.4rem 0.75rem' }}>
            <Skeleton width="100%" height={20} borderRadius={6} />
          </div>
        ))}
      </>
    );
  }

  // Filter out the system "Liked Music" (LM) playlist from the list
  const filteredPlaylists = playlists.filter(p => p.id !== 'LM');

  return (
    <>
      {filteredPlaylists.map(pl => (
        <PlaylistItem 
          key={pl.id}
          playlist={pl}
          isActive={activePlaylistId === pl.id}
          collapsed={collapsed}
          onSelectView={onSelectView}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
});

export const Sidebar: React.FC<SidebarProps> = memo(({
  collapsed = false,
  onToggleCollapse,
  playlists = [],
  activePlaylistId,
  onSelectView,
  isAuthenticated,
  isInitializing,
  onLogout,
  user,
  className,
  activeViewType
}) => {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const playlistMenuRef = useRef<PlaylistContextMenuRef>(null);
  const [isPromptOpen, setIsPromptOpen] = useState(false);

  const handleCreatePlaylist = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsPromptOpen(true);
  }, []);

  const onConfirmCreate = async (title: string) => {
    setIsPromptOpen(false);
    if (title.trim()) {
      const newId = await createPlaylist(title);
      if (newId) {
        showToast(`Playlist "${title}" created`, 'success');
        queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
      } else {
        showToast('Failed to create playlist', 'error');
      }
    }
  };

  const handlePlaylistContextMenu = useCallback((e: React.MouseEvent, playlist: YTMPlaylist) => {
    playlistMenuRef.current?.open(e, playlist);
  }, []);

  const handlePlaylistSelect = useCallback((playlist: YTMPlaylist) => {
    onSelectView?.({ type: 'playlist', playlistId: playlist.id, playlistTitle: playlist.title });
  }, [onSelectView]);

  const handleNavigateHome = useCallback(() => {
    onSelectView?.({ type: 'home' });
  }, [onSelectView]);

  const handleNavigateLiked = useCallback(() => {
    onSelectView?.({ type: 'playlist', playlistId: 'LM', playlistTitle: 'Liked Songs' });
  }, [onSelectView]);

  const handleNavigateHistory = useCallback(() => {
    onSelectView?.({ type: 'history' });
  }, [onSelectView]);

  const handleNavigateNewReleases = useCallback(() => {
    onSelectView?.({ type: 'new-releases' });
  }, [onSelectView]);

  const handleNavigateRadio = useCallback(() => {
    onSelectView?.({ type: 'radio' });
  }, [onSelectView]);

  // Check if Liked Songs is active (either via dedicated type or via playlistId LM)
  const isLikedActive = activeViewType === 'liked' || activePlaylistId === 'LM';

  return (
    <aside className={`${sidebarStyles.sidebar} ${collapsed ? sidebarStyles.collapsed : ''} ${className || ''}`}>
      <SidebarHeader 
        collapsed={collapsed} 
        onToggleCollapse={onToggleCollapse} 
        onSelectView={onSelectView} 
        activeViewType={activeViewType}
      />

      {isAuthenticated && (
        <UserProfileSection 
          user={user} 
          collapsed={collapsed} 
          onSelectView={onSelectView} 
          onLogout={onLogout} 
        />
      )}

      <div className={sidebarStyles.mainNav}>
        <NavLink
          icon={Home}
          label={collapsed ? '' : 'Home'}
          active={activeViewType === 'home'}
          onClick={handleNavigateHome}
          tooltip={collapsed ? 'Home' : undefined}
        />
        <NavLink
          icon={Sparkles}
          label={collapsed ? '' : 'New Releases'}
          active={activeViewType === 'new-releases'}
          onClick={handleNavigateNewReleases}
          tooltip={collapsed ? 'New Releases' : undefined}
        />
        <NavLink
          icon={Heart}
          label={collapsed ? '' : 'Liked Songs'}
          active={isLikedActive}
          onClick={handleNavigateLiked}
          tooltip={collapsed ? 'Liked Songs' : undefined}
        />
        <NavLink
          icon={Radio}
          label={collapsed ? '' : 'Radio'}
          active={activeViewType === 'radio'}
          onClick={handleNavigateRadio}
          tooltip={collapsed ? 'Radio' : undefined}
        />
        <NavLink
          icon={History}
          label={collapsed ? '' : 'History'}
          active={activeViewType === 'history'}
          onClick={handleNavigateHistory}
          tooltip={collapsed ? 'History' : undefined}
        />
      </div>

      <div className={sidebarStyles.playlistSection}>
        <div className={sidebarStyles.sectionHeader}>
          <h3 className={sidebarStyles.sectionTitle}>{collapsed ? '' : 'Collection'}</h3>
          {!collapsed && (
            <IconButton 
              icon={Plus} 
              size={24} 
              iconSize={14} 
              onClick={handleCreatePlaylist} 
              title="Create Playlist"
              className={sidebarStyles.addPlaylistBtn}
            />
          )}
        </div>
        
        <div className={sidebarStyles.scrollArea}>
          <nav className={sidebarStyles.nav}>
            <PlaylistList 
              playlists={playlists}
              activePlaylistId={activePlaylistId}
              collapsed={collapsed}
              isInitializing={!!isInitializing}
              onSelectView={onSelectView}
              onContextMenu={handlePlaylistContextMenu}
            />
          </nav>
        </div>
      </div>

      <PlaylistContextMenu 
        ref={playlistMenuRef} 
        onSelect={handlePlaylistSelect} 
        onNavigateHome={handleNavigateHome}
      />
      
      <InputDialog
        isOpen={isPromptOpen}
        title="Create New Playlist"
        placeholder="Enter playlist title..."
        onConfirm={onConfirmCreate}
        onCancel={() => setIsPromptOpen(false)}
      />
    </aside>
  );
});
