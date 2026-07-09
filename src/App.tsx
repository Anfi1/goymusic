import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppLayout } from './components/templates/AppLayout';
import { Sidebar } from './components/organisms/Sidebar';
import { PlayerBar } from './components/organisms/PlayerBar';
import { UpdateNotification } from './components/molecules/UpdateNotification';
import { QueuePanel } from './components/organisms/QueuePanel';
import { MainView } from './components/organisms/MainView';
import { ArtistView } from './components/organisms/ArtistView';
import { HomeView } from './components/organisms/HomeView';
import { HistoryView } from './components/organisms/HistoryView';
import { TitleBar } from './components/organisms/TitleBar';
import { SettingsView } from './components/organisms/SettingsView';
import { LyricsView } from './components/organisms/LyricsView';
import { NewReleasesView } from './components/organisms/NewReleasesView';
import { RadioView } from './components/organisms/RadioView';
import { MyWaveView } from './components/organisms/MyWaveView';
import { ImageViewer } from './components/molecules/ImageViewer';

import { ToastProvider } from './components/atoms/Toast';
import { isLoggedIn, loadAuth, clearTokens } from './api/yt';
import { player } from './api/player';
import { parseDeepLink } from './api/trackLink';
import { resolveScTrack } from './api/soundcloud';
import { ActiveView } from './types';
import './styles/theme.css';
import './styles/base.css';
import './styles/badges.css';
import { useLibrary } from './hooks/useLibrary';

// Separate component to isolate Main content
const MainContentWrapper = memo(
  ({
    activeView,
    refreshKey,
    handleLogout,
    handleSelectArtist,
    handleSelectAlbum,
    handleSelectPlaylist,
    handleArtistViewModeChange,
    handleSearch,
    handleBack,
    historyLength,
    user,
    isAuthenticated,
    isInitializing,
    navigate,
  }: any) => {
    const viewKey = `${activeView.type}-${activeView.playlistId || ''}-${activeView.artistId || ''}-${activeView.albumId || ''}-${activeView.searchQuery || ''}-${refreshKey}`;

    return (
      <div style={{ height: '100%' }}>
        {activeView.type === 'settings' ? (
          <SettingsView key="settings" onLogout={handleLogout} />
        ) : activeView.type === 'history' ? (
          <HistoryView
            key="history"
            onSelectArtist={handleSelectArtist}
            onSelectAlbum={handleSelectAlbum}
          />
        ) : activeView.type === 'new-releases' ? (
          <NewReleasesView
            key="new-releases"
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
            onSelectArtist={handleSelectArtist}
          />
        ) : activeView.type === 'radio' ? (
          <RadioView key="radio" />
        ) : activeView.type === 'my-wave' ? (
          <MyWaveView
            key="my-wave"
            onSelectArtist={handleSelectArtist}
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
          />
        ) : activeView.type === 'artist' && activeView.artistId ? (
          <ArtistView
            key={`artist-${activeView.artistId}`}
            artistId={activeView.artistId}
            onSelectArtist={handleSelectArtist}
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
            onViewModeChange={handleArtistViewModeChange}
          />
        ) : activeView.type === 'home' ? (
          <HomeView
            key="home"
            onSelectArtist={handleSelectArtist}
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
          />
        ) : (
          <MainView
            key={viewKey}
            activeView={activeView}
            isAuthenticated={isAuthenticated}
            isInitializing={isInitializing}
            user={user}
            onSearch={handleSearch}
            onSearchAgain={handleSearch}
            onSelectArtist={handleSelectArtist}
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
            onSelectHome={() => {}}
            onBack={handleBack}
            canGoBack={historyLength > 0}
          />
        )}
      </div>
    );
  }
);

// Memoized Layout Components
const MemoizedSidebar = memo(Sidebar);
const MemoizedPlayerBar = memo(PlayerBar);
const MemoizedQueuePanel = memo(QueuePanel);
const MemoizedLyricsView = memo(LyricsView);
const MemoizedTitleBar = memo(TitleBar);

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [rightPanelContent, setRightPanelContent] = useState<
    'queue' | 'lyrics' | 'none'
  >('queue');
  const savedRightPanelRef = useRef<'queue' | 'lyrics' | 'none'>('queue');

  const [history, setHistory] = useState<ActiveView[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    const saved = localStorage.getItem('goymusic-active-view');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.type === 'auth') return { type: 'home' };
        return parsed;
      } catch (e) {}
    }
    return { type: 'home' };
  });
  const isMyWave = activeView.type === 'my-wave';

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const [hideGlobalBack, setHideGlobalBack] = useState(false);
  const {
    playlists,
    user,
    refetch: refetchLibrary,
    isLoading: isLibraryLoading,
  } = useLibrary(isAuthenticated);

  const navigate = useCallback((view: ActiveView) => {
    setActiveView((prev) => {
      // Безопасное сравнение без JSON.stringify (может падать на circular refs)
      const same = prev.type === view.type &&
        prev.playlistId === view.playlistId &&
        prev.artistId === view.artistId &&
        prev.albumId === view.albumId &&
        prev.searchQuery === view.searchQuery;
      if (same) {
        setRefreshKey((k) => k + 1);
        return prev;
      }
      setHistory((h) => [...h, prev].slice(-50));
      return view;
    });
    setHideGlobalBack(false);
  }, []);

  useEffect(() => {
    localStorage.setItem('goymusic-active-view', JSON.stringify(activeView));
  }, [activeView]);

  // При входе в My Wave запоминаем и скрываем правую панель/плеер; при выходе восстанавливаем.
  useEffect(() => {
    if (isMyWave) {
      savedRightPanelRef.current = rightPanelContent;
      setRightPanelContent('none');
    } else {
      setRightPanelContent(savedRightPanelRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyWave]);

  useEffect(() => {
    return window.bridge.onDeepLink(async (url: string) => {
      const link = parseDeepLink(url);
      if (!link) return;
      if (link.type === 'track') {
        let track = {
          id: link.id,
          title: link.title,
          artists: link.artists,
          thumbUrl: link.thumbUrl,
          album: '',
          duration: '',
          scUrl: link.scUrl,
          source: link.source,
        } as any;
        if (link.source === 'soundcloud' && link.scUrl) {
          const resolved = await resolveScTrack(link.scUrl);
          if (resolved) track = resolved;
        }
        player.startRadio(track);
      } else if (link.type === 'album') {
        navigate({ type: 'album', albumId: link.id });
      }
    });
  }, [navigate]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const tip = document.createElement('div');
    tip.className = 'global-tooltip';
    document.body.appendChild(tip);
    const TOOLTIP_FADE_DURATION = 300;
    const STYLE_PERSIST_DURATION = Math.round(TOOLTIP_FADE_DURATION * 1.5);
    let current: Element | null = null;
    let pendingEl: Element | null = null;
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingHideTimer: ReturnType<typeof setTimeout> | null = null;

    const show = (e: MouseEvent) => {
      // clean up if current element was removed from DOM
      if (current && !document.contains(current)) {
        current = null;
        tip.style.opacity = '0';
      }
      const el = (e.target as Element).closest('[data-tooltip]');
      if (!el) return;
      // For PRO/verified badges — show tooltip with themed color
      const isProBadge = el.classList.contains('pro-badge');
      const isVerifiedBadge = el.classList.contains('verified-badge') || el.classList.contains('verified-badge-lg') || el.classList.contains('verified-badge--tr') || el.classList.contains('verified-badge--sm');
      const isVerifiedBadgeLg = el.classList.contains('verified-badge-lg');
      const isVerifiedBadgeTr = el.classList.contains('verified-badge--tr');
      const isVerifiedBadgeSm = el.classList.contains('verified-badge--sm');
      const badgeEl = isProBadge ? el : (el.parentElement && el.parentElement.classList.contains('pro-badge')) ? el.parentElement : null;
      const verifiedEl = isVerifiedBadge ? (isVerifiedBadgeLg ? el : isVerifiedBadgeTr ? el : isVerifiedBadgeSm ? el : el.parentElement && el.parentElement.classList.contains('verified-badge') ? el.parentElement : el) : null;
      if (badgeEl || verifiedEl || isVerifiedBadgeLg || isVerifiedBadgeTr || isVerifiedBadgeSm) {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (pendingHideTimer) { clearTimeout(pendingHideTimer); pendingHideTimer = null; }
        pendingEl = null;
        current = isVerifiedBadgeLg ? el : isVerifiedBadgeTr ? el : isVerifiedBadgeSm ? el : (badgeEl || verifiedEl);
        tip.textContent = isVerifiedBadgeLg ? 'Verified' : isVerifiedBadgeTr ? 'Verified' : isVerifiedBadgeSm ? 'Verified' : (badgeEl ? 'Artist PRO' : 'Verified');
        const tw = tip.offsetWidth || 200;
        const cx = e.clientX, cy = e.clientY;
        const x = Math.min(cx + 14, window.innerWidth - tw - 8);
        const y = cy - 28 < 8 ? cy + 20 : cy - 28;
        tip.style.setProperty('--tooltip-color', isVerifiedBadgeLg ? '#1d9bf0' : (badgeEl ? '#f59e0b' : '#1d9bf0'));
        tip.style.borderColor = isVerifiedBadgeLg ? 'rgba(29, 155, 240, 0.3)' : (badgeEl ? 'rgba(245, 158, 11, 0.3)' : 'rgba(29, 155, 240, 0.3)');
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
        tip.style.transition = 'opacity 0.18s cubic-bezier(0.0, 0.0, 0.2, 1)';
        tip.style.opacity = '1';
        return;
      }
      if (el === current || el === pendingEl) return;
      // overflow-only: only show if text is actually truncated (+1 tolerance for subpixel rounding)
      if (
        el.getAttribute('data-tooltip-overflow') !== null &&
        el.scrollWidth <= el.clientWidth + 1
      )
        return;
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      pendingEl = el;
      const cx = e.clientX,
        cy = e.clientY;
      showTimer = setTimeout(() => {
        showTimer = null;
        pendingEl = null;
        current = el;
        tip.style.removeProperty('--tooltip-color');
        tip.style.removeProperty('border-color');
        tip.textContent = el.getAttribute('data-tooltip');
        const tw = tip.offsetWidth || 200;
        const x = Math.min(cx + 14, window.innerWidth - tw - 8);
        const y = cy - 28 < 8 ? cy + 20 : cy - 28;
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
        tip.style.transition = 'opacity 0.18s cubic-bezier(0.0, 0.0, 0.2, 1)';
        tip.style.opacity = '1';
      }, 700);
    };
    const hide = (e: MouseEvent) => {
      const target = e.target as Element;
      const badgeEl = target.classList.contains('pro-badge') ? target : (target.parentElement && target.parentElement.classList.contains('pro-badge')) ? target.parentElement : null;
      const verifiedEl = target.classList.contains('verified-badge') ? target : target.classList.contains('verified-badge-lg') ? target : target.classList.contains('verified-badge--tr') ? target : target.classList.contains('verified-badge--sm') ? target : (target.parentElement && target.parentElement.classList.contains('verified-badge')) ? target.parentElement : null;
      const isVerifiedBadgeLgHide = target.classList.contains('verified-badge-lg');
      const isVerifiedBadgeTrHide = target.classList.contains('verified-badge--tr');
      const isVerifiedBadgeSmHide = target.classList.contains('verified-badge--sm');
      if (badgeEl || verifiedEl || isVerifiedBadgeLgHide || isVerifiedBadgeTrHide || isVerifiedBadgeSmHide) {
        const related = e.relatedTarget as Element | null;
        if (isVerifiedBadgeLgHide && related && (target.contains(related) || verifiedEl?.contains(related))) return;
        if (isVerifiedBadgeLgHide && related && related.classList.contains('pro-badge')) return;
        if (isVerifiedBadgeLgHide && related && related.parentElement?.classList.contains('pro-badge')) return;
        if (isVerifiedBadgeTrHide && related && (target.contains(related) || verifiedEl?.contains(related))) return;
        if (isVerifiedBadgeTrHide && related && related.classList.contains('pro-badge')) return;
        if (isVerifiedBadgeTrHide && related && related.parentElement?.classList.contains('pro-badge')) return;
        if (isVerifiedBadgeSmHide && related && (target.contains(related) || verifiedEl?.contains(related))) return;
        if (isVerifiedBadgeSmHide && related && related.classList.contains('pro-badge')) return;
        if (isVerifiedBadgeSmHide && related && related.parentElement?.classList.contains('pro-badge')) return;
        if (related && (badgeEl?.contains(related) || verifiedEl?.contains(related))) return;
        let node: Element | null = related;
        const container = badgeEl?.parentElement || verifiedEl?.parentElement || target.parentElement;
        while (node && node !== container) {
          if ((node.classList.contains('pro-badge') || node.classList.contains('verified-badge') || node.classList.contains('verified-badge-lg') || node.classList.contains('verified-badge--tr') || node.classList.contains('verified-badge--sm')) ||
              (node.parentElement && (node.parentElement.classList.contains('pro-badge') || node.parentElement.classList.contains('verified-badge')))) {
            return;
          }
          node = node.parentElement;
        }
        tip.style.opacity = '0';
        pendingHideTimer = setTimeout(() => {
          pendingHideTimer = null;
          if (current && document.contains(current)) return;
          tip.style.removeProperty('--tooltip-color');
          tip.style.removeProperty('border-color');
          current = null;
        }, STYLE_PERSIST_DURATION);
        return;
      }
      const el = (e.target as Element).closest('[data-tooltip]');
      if (el === pendingEl) {
        if (showTimer) {
          clearTimeout(showTimer);
          showTimer = null;
        }
        pendingEl = null;
      }
      if (el === current) {
        current = null;
        tip.style.transition = 'opacity 0.3s cubic-bezier(0.4, 0.0, 1, 1)';
        tip.style.opacity = '0';
      }
    };
    const move = (e: MouseEvent) => {
      if (tip.style.opacity !== '0') {
        const tw = tip.offsetWidth || 200;
        const x = Math.min(e.clientX + 14, window.innerWidth - tw - 8);
        const y = e.clientY - 28 < 8 ? e.clientY + 20 : e.clientY - 28;
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      }
    };

    document.addEventListener('mouseover', show);
    document.addEventListener('mouseout', hide);
    document.addEventListener('mousemove', move);
    tip.addEventListener('mouseenter', () => {
      if (pendingHideTimer) { clearTimeout(pendingHideTimer); pendingHideTimer = null; }
    });
    tip.addEventListener('mouseleave', () => {
      tip.style.opacity = '0';
      if (pendingHideTimer) { clearTimeout(pendingHideTimer); pendingHideTimer = null; }
    });
    const badgeMouseEnter = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const isBadge = target.classList.contains('pro-badge') || target.classList.contains('verified-badge');
      const parent = target.parentElement;
      const badgeEl = isBadge ? target : (parent?.classList && (parent.classList.contains('pro-badge') || parent.classList.contains('verified-badge'))) ? parent : null;
      if (badgeEl) {
        if (pendingHideTimer) { clearTimeout(pendingHideTimer); pendingHideTimer = null; }
      }
    };
    document.addEventListener('mouseenter', badgeMouseEnter);
    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('mouseout', hide);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseenter', badgeMouseEnter);
      if (showTimer) clearTimeout(showTimer);
      if (pendingHideTimer) clearTimeout(pendingHideTimer);
      tip.remove();
    };
  }, []);

  const init = async () => {
    setIsInitializing(true);
    setInitError(null);
    try {
      const authed = await isLoggedIn();
      setIsAuthenticated(authed);
      setIsInitializing(false);
    } catch (e: any) {
      setInitError(`Initialization failed: ${e.message || e}`);
      setIsInitializing(false);
    }
  };

  useEffect(() => {
    init();
    const unlisten = window.bridge.onPyEvent(async (msg) => {
      if (msg.event === 'auth_complete') {
        setIsAuthenticating(false);
        const success = await loadAuth();
        setIsAuthenticated(success);
        if (success) {
          refetchLibrary();
          navigate({ type: 'home' });
        }
      } else if (msg.event === 'auth_error') {
        setAuthError(msg.message);
        setIsAuthenticating(false);
      } else if (msg.event === 'backend_dead') {
        setInitError(`Backend process exited (code ${msg.code}).`);
        setIsInitializing(true);
      }
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [navigate]);

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      const newHistory = [...prev];
      const previousView = newHistory.pop();
      if (previousView) {
        setActiveView(previousView);
        setHideGlobalBack(false);
      }
      return newHistory;
    });
  }, []);

  const queryClient = useQueryClient();

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries();
    setRefreshKey((k) => k + 1);
    if (isAuthenticated) refetchLibrary();
  }, [isAuthenticated, refetchLibrary, queryClient]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'F5') {
        e.preventDefault();
        handleRefresh();
      }
      if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        player.togglePlay();
      }
      if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (player.duration) player.seek(Math.max(0, player.currentTime - 5));
      }
      if (e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (player.duration) player.seek(Math.min(player.duration, player.currentTime + 5));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRefresh]);

  const handleLogout = useCallback(async () => {
    player.reset();
    await clearTokens();
    setIsAuthenticated(false);
    setHistory([]);
    setActiveView({ type: 'home' });
    queryClient.clear();
  }, [queryClient]);

  const toggleTheme = useCallback(
    () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')),
    []
  );
  const toggleSidebar = useCallback(
    () => setIsSidebarCollapsed((prev) => !prev),
    []
  );
  const toggleRightPanel = useCallback(
    (panel: 'queue' | 'lyrics') => {
      // В режиме My Wave панель управляется самим экраном волны, игнорируем внешний тоггл.
      if (isMyWave) return;
      setRightPanelContent((prev) => (prev === panel ? 'none' : panel));
    },
    [isMyWave]
  );

  const handleSelectArtist = useCallback(
    (id: string) => navigate({ type: 'artist', artistId: id }),
    [navigate]
  );
  const handleSelectAlbum = useCallback(
    (id: string) => navigate({ type: 'album', albumId: id }),
    [navigate]
  );
  const handleSelectPlaylist = useCallback(
    (id: string, title: string) =>
      navigate({ type: 'playlist', playlistId: id, playlistTitle: title }),
    [navigate]
  );
  const handleSearch = useCallback(
    (q: string) => {
      if (!q) return;
      console.log('[search] Triggering search for:', q);
      queryClient.invalidateQueries({ queryKey: ['search', q] });
      navigate({ type: 'search', searchQuery: q });
    },
    [navigate, queryClient]
  );
  const handleArtistViewModeChange = useCallback(
    (mode: string = 'main') => setHideGlobalBack(mode !== 'main'),
    []
  );

  const startLogin = async () => {
    setAuthError(null);
    setIsAuthenticating(true);
    try {
      const res = await window.bridge.authStart();
      if (res.status === 'error' || res.status === 'cancelled') {
        setIsAuthenticating(false);
        if (res.status === 'error') setAuthError(res.message);
      }
    } catch (e: any) {
      setAuthError(e.message);
      setIsAuthenticating(false);
    }
  };

  const activePlaylistId = useMemo(
    () => (activeView.type === 'playlist' ? activeView.playlistId : null),
    [activeView.type, activeView.playlistId]
  );

  const sidebarComp = useMemo(() => {
    if (!isAuthenticated || isInitializing) return undefined;
    return (
      <MemoizedSidebar
        collapsed={isSidebarCollapsed}
        immersive={isMyWave}
        onToggleCollapse={toggleSidebar}
        playlists={playlists}
        activePlaylistId={activePlaylistId}
        onSelectView={navigate}
        isAuthenticated={isAuthenticated}
        isInitializing={isLibraryLoading}
        onLogout={handleLogout}
        user={user}
        activeViewType={activeView.type}
      />
    );
  }, [
    isAuthenticated,
    isInitializing,
    isSidebarCollapsed,
    toggleSidebar,
    playlists,
    activePlaylistId,
    navigate,
    handleLogout,
    user,
    isLibraryLoading,
    activeView.type,
  ]);

  const playerBarComp = useMemo(() => {
    if (!isAuthenticated || isInitializing) return undefined;
    return (
      <MemoizedPlayerBar
        activeRightPanel={rightPanelContent}
        onToggleRightPanel={toggleRightPanel}
        onSelectArtist={handleSelectArtist}
        onSelectAlbum={handleSelectAlbum}
      />
    );
  }, [
    isAuthenticated,
    isInitializing,
    rightPanelContent,
    toggleRightPanel,
    handleSelectArtist,
    handleSelectAlbum,
  ]);

  const rightPanelComp = useMemo(() => {
    if (!isAuthenticated || isInitializing) return undefined;

    return (
      <div
        style={{
          height: '100%',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: rightPanelContent === 'queue' ? 'contents' : 'none',
            height: '100%',
          }}
        >
          <MemoizedQueuePanel
            isVisible={rightPanelContent === 'queue'}
            onSelectAlbum={handleSelectAlbum}
            onSelectPlaylist={handleSelectPlaylist}
            onSelectArtist={handleSelectArtist}
          />
        </div>
        <div
          style={{
            display: rightPanelContent === 'lyrics' ? 'contents' : 'none',
            height: '100%',
          }}
        >
          <MemoizedLyricsView isVisible={rightPanelContent === 'lyrics'} />
        </div>
      </div>
    );
  }, [
    isAuthenticated,
    isInitializing,
    rightPanelContent,
    handleSelectAlbum,
    handleSelectPlaylist,
    handleSelectArtist,
  ]);

  // ABSOLUTELY ISOLATED Main content
  const mainContent = useMemo(
    () => (
      <MainContentWrapper
        activeView={activeView}
        refreshKey={refreshKey}
        handleLogout={handleLogout}
        handleSelectArtist={handleSelectArtist}
        handleSelectAlbum={handleSelectAlbum}
        handleSelectPlaylist={handleSelectPlaylist}
        handleArtistViewModeChange={handleArtistViewModeChange}
        handleSearch={handleSearch}
        handleBack={handleBack}
        historyLength={history.length}
        user={user}
        isAuthenticated={isAuthenticated}
        isInitializing={isInitializing}
        navigate={navigate}
      />
    ),
    [
      activeView,
      refreshKey,
      handleLogout,
      handleSelectArtist,
      handleSelectAlbum,
      handleSelectPlaylist,
      handleArtistViewModeChange,
      handleSearch,
      handleBack,
      history.length,
      user,
      isAuthenticated,
      isInitializing,
      navigate,
    ]
  );

  const activeSearchQuery = useMemo(
    () => (activeView.type === 'search' ? activeView.searchQuery : ''),
    [activeView.type, activeView.searchQuery]
  );
  const canGoBack = history.length > 0 && !hideGlobalBack;

  const titleBarComp = useMemo(
    () => (
      <MemoizedTitleBar
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={handleBack}
        onRefresh={handleRefresh}
        onSearch={handleSearch}
        canGoBack={canGoBack && !isMyWave}
        activeSearchQuery={activeSearchQuery}
        isInitializing={isInitializing}
      />
    ),
    [
      theme,
      toggleTheme,
      handleBack,
      handleRefresh,
      handleSearch,
      canGoBack,
      isMyWave,
      activeSearchQuery,
      isInitializing,
    ]
  );

  return (
    <ToastProvider>
      <UpdateNotification />
      <AppLayout
        titleBar={titleBarComp}
        sidebar={sidebarComp}
        rightPanel={rightPanelComp}
        playerBar={playerBarComp}
        isSidebarCollapsed={isSidebarCollapsed}
        isQueueVisible={
          rightPanelContent !== 'none' && isAuthenticated && !isInitializing
        }
        hidePlayerBar={isMyWave}
        hideRightPanel={isMyWave}
        hideBackButton={isMyWave}
        onBack={handleBack}
        canGoBack={canGoBack && activeView.type !== 'home'}
      >
        {isInitializing ? (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#cdd6f4',
              padding: '2rem',
            }}
          >
            <div style={{ textAlign: 'center', maxWidth: '400px' }}>
              <h2
                style={{
                  marginBottom: '1.5rem',
                  opacity: 0.9,
                  fontSize: '1.5rem',
                  fontWeight: 600,
                }}
              >
                GoyMusic
              </h2>
              {!initError ? (
                <>
                  <div
                    className="loading-spinner"
                    style={{
                      width: '40px',
                      height: '40px',
                      border: '4px solid rgba(137,180,250,0.1)',
                      borderTopColor: '#89b4fa',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                      margin: '0 auto',
                    }}
                  ></div>
                  <p style={{ marginTop: '1.5rem', opacity: 0.6 }}>
                    Initializing backend...
                  </p>
                </>
              ) : (
                <div
                  style={{
                    color: '#f38ba8',
                    backgroundColor: 'rgba(243,139,168,0.1)',
                    padding: '1.5rem',
                    borderRadius: '16px',
                    border: '1px solid rgba(243,139,168,0.2)',
                  }}
                >
                  <p style={{ fontWeight: 700, marginBottom: '0.5rem' }}>
                    Startup Error
                  </p>
                  <p
                    style={{
                      fontSize: '0.9rem',
                      opacity: 0.9,
                      marginBottom: '1rem',
                    }}
                  >
                    {initError}
                  </p>
                  <button
                    onClick={() => init()}
                    style={{
                      backgroundColor: '#f38ba8',
                      color: '#11111b',
                      border: 'none',
                      padding: '0.5rem 1.5rem',
                      borderRadius: '8px',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        ) : !isAuthenticated ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2rem',
              padding: '2rem',
              textAlign: 'center',
              color: '#ffffff',
              background: '#09090f',
            }}
          >
            <h1
              style={{
                fontSize: 'min(4.5rem, 12vh)',
                fontWeight: 900,
                background: 'linear-gradient(135deg, #89b4fa 0%, #b4befe 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 0 30px rgba(137,180,250,0.3))',
              }}
            >
              GoyMusic
            </h1>
            {authError && (
              <div
                style={{
                  color: '#f38ba8',
                  backgroundColor: 'rgba(243,139,168,0.15)',
                  padding: '1rem 2rem',
                  borderRadius: '12px',
                  border: '1px solid rgba(243,139,168,0.3)',
                  maxWidth: '400px',
                }}
              >
                {authError}
              </div>
            )}
            <button
              onClick={startLogin}
              disabled={isAuthenticating}
              style={{
                padding: '1.25rem 3.5rem',
                backgroundColor: '#89b4fa',
                border: 'none',
                borderRadius: '20px',
                cursor: isAuthenticating ? 'default' : 'pointer',
                color: '#11111b',
                fontWeight: 800,
                fontSize: '1.4rem',
                boxShadow: '0 10px 40px rgba(137,180,250,0.4)',
              }}
            >
              {isAuthenticating
                ? 'Opening login window...'
                : 'Sign in with YouTube'}
            </button>
          </div>
        ) : (
          mainContent
        )}
      </AppLayout>
      <ImageViewer />
    </ToastProvider>
  );
}

export default memo(App);
