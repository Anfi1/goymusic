import React, { useEffect, useState, memo, useMemo } from 'react';
import { player } from '../../api/player';
import { ChevronLeft } from 'lucide-react';
import { IconButton } from '../atoms/IconButton';
import { ErrorBoundary } from '../atoms/ErrorBoundary';
import styles from './AppLayout.module.css';

interface AppLayoutProps {
  titleBar: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  rightPanel?: React.ReactNode;
  playerBar?: React.ReactNode;
  isSidebarCollapsed?: boolean;
  isQueueVisible?: boolean;
  onBack?: () => void;
  canGoBack?: boolean;
}

/**
 * Template: AppLayout
 * The main application layout with TitleBar, Sidebar, Main content, Queue, and PlayerBar.
 */
export const AppLayout: React.FC<AppLayoutProps> = memo(({
  titleBar,
  sidebar,
  children,
  rightPanel,
  playerBar,
  isQueueVisible = true,
  onBack,
  canGoBack = false
}) => {
  const [thumb, setThumb] = useState(player.currentTrack?.thumbUrl || '');

  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'tick') return;
      setThumb(player.currentTrack?.thumbUrl || '');
    });
  }, []);

  // Stabilize the layout parts that shouldn't re-render when children or queue visibility changes
  const memoizedTitleBar = useMemo(() => titleBar, [titleBar]);
  const memoizedSidebar = useMemo(() => sidebar, [sidebar]);
  const memoizedPlayerBar = useMemo(() => playerBar, [playerBar]);

  return (
    <div className={styles.appWindow}>
      {/* Ambient background layer */}
      {thumb && (
        <div
          className={styles.ambientBlur}
          style={{ backgroundImage: `url(${thumb})` }}
        />
      )}

      {memoizedTitleBar}
      
      <ErrorBoundary 
        fallbackStyle={{ gridArea: '2 / 1 / 4 / 4' }}
        onReset={() => {
          localStorage.removeItem('goymusic-active-view');
          window.location.reload();
        }}
      >
        <div style={{ display: 'contents' }}>
          {memoizedSidebar}
          <main className={styles.main}>
            {canGoBack && onBack && (
              <div className={styles.contextualBack}>
                <IconButton 
                  icon={ChevronLeft} 
                  onClick={onBack} 
                  size={40}
                  iconSize={24}
                  variant="solid"
                  title="Go Back"
                />
              </div>
            )}
            <div className={styles.scrollContent}>
              {children}
            </div>
          </main>
          
          <aside className={`${styles.rightSidebar} ${isQueueVisible ? styles.visible : ''}`}>
            {rightPanel}
          </aside>

          {memoizedPlayerBar}
        </div>
      </ErrorBoundary>
    </div>
  );
});
