import React, { useLayoutEffect, useState, memo, useSyncExternalStore } from 'react';
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

function sampleCover(event: React.SyntheticEvent<HTMLImageElement>) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(event.currentTarget, 0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a) document.documentElement.style.setProperty('--track-color', `rgb(${r} ${g} ${b})`);
  } catch {
    // Restricted artwork can still paint the wash, using the default tint.
  }
}

function AmbientCover({ src }: { src: string }) {
  const [allowSampling, setAllowSampling] = useState(true);
  // The root is shared by the shell and menus rendered through body portals.
  useLayoutEffect(() => () => {
    document.documentElement.style.removeProperty('--track-color');
  }, []);

  return (
    <img
      crossOrigin={allowSampling ? 'anonymous' : undefined}
      src={src}
      alt=""
      className={styles.ambientBlur}
      aria-hidden="true"
      draggable={false}
      onLoad={allowSampling ? sampleCover : undefined}
      onError={allowSampling ? () => setAllowSampling(false) : undefined}
    />
  );
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
  hidePlayerBar = false,
  hideRightPanel = false,
  hideBackButton = false,
  onBack,
  canGoBack = false
}) => {
  const thumb = useSyncExternalStore(subscribeToTrack, currentCover);

  return (
    <div className={styles.appWindow}>
      {thumb && <AmbientCover key={thumb} src={thumb} />}

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
