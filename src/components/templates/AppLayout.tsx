import React, { useState, memo, useSyncExternalStore } from 'react';
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
  isQueueVisible?: boolean;
  hidePlayerBar?: boolean;
  hideRightPanel?: boolean;
  hideBackButton?: boolean;
  onBack?: () => void;
  canGoBack?: boolean;
}

const subscribeToTrack = (notify: () => void) => player.subscribe(notify);
const currentCover = () => player.currentTrack?.thumbUrl || '';

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
  hidePlayerBar = false,
  hideRightPanel = false,
  hideBackButton = false,
  onBack,
  canGoBack = false
}) => {
  const thumb = useSyncExternalStore(subscribeToTrack, currentCover);
  const [tint, setTint] = useState<{ url: string; color: string }>();

  const sampleCover = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(image, 0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (a) setTint({ url: thumb, color: `rgb(${r} ${g} ${b})` });
    } catch {
      // A cover can still paint normally if its origin disallows pixel sampling.
    }
  };

  return (
    <div className={styles.appWindow} style={tint?.url === thumb ? { '--track-color': tint.color } as React.CSSProperties : undefined}>
      {/* Ambient background layer */}
      {thumb && (
        <img
          key={thumb}
          src={thumb}
          alt=""
          className={styles.ambientBlur}
          aria-hidden="true"
          draggable={false}
          onLoad={sampleCover}
        />
      )}

      {titleBar}
      
      <ErrorBoundary 
        fallbackStyle={{ gridArea: '2 / 1 / 4 / 4' }}
        onReset={() => {
          localStorage.removeItem('goymusic-active-view');
          window.location.reload();
        }}
      >
        <div style={{ display: 'contents' }}>
          {sidebar}
          <main className={`${styles.main} ${hidePlayerBar ? styles.mainImmersive : ''}`}>
            {canGoBack && onBack && !hideBackButton && (
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
          
          <aside
            className={`${styles.rightSidebar} ${isQueueVisible && !hideRightPanel ? styles.visible : ''} ${hideRightPanel ? styles.hiddenPanel : ''}`}
            aria-label="Playback panel"
            inert={!isQueueVisible || hideRightPanel}
          >
            {rightPanel}
          </aside>

          {!hidePlayerBar && playerBar}
        </div>
      </ErrorBoundary>
    </div>
  );
});
