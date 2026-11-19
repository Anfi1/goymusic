import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { ActiveView } from '../../types';
import { isDeckLayout } from '../../utils/desktopLayout';

type Direction = 'initial' | 'forward' | 'back';
type Entry = { view: ActiveView; scrollTop: number };
type Stack = { entry: Entry; history: Entry[]; direction: Direction; refreshKey: number };

const historyLimit = 50;

function routeKey(view: ActiveView): string {
  switch (view.type) {
    case 'album': return `album-${view.albumId}`;
    case 'artist': return `artist-${view.artistId}`;
    case 'playlist': return `playlist-${view.playlistId}`;
    case 'search': return `search-${view.searchQuery}`;
    case 'yandex-genre': return `yandex-genre-${view.genreId}`;
    default: return view.type;
  }
}

function initialStack(): Stack {
  let view: ActiveView = { type: 'home' };
  try {
    const saved: ActiveView | null = JSON.parse(localStorage.getItem('goymusic-active-view') ?? 'null');
    if (saved?.type && saved.type !== 'auth') view = saved;
  } catch { /* Ignore a corrupt saved route. */ }
  return { entry: { view, scrollTop: 0 }, history: [], direction: 'initial', refreshKey: 0 };
}

function scroller(page: HTMLElement): HTMLElement {
  const owned = page.querySelector<HTMLElement>('[data-collection-scroll], [data-artist-view], .deck-scroll');
  if (owned) return owned;
  const root = page.firstElementChild?.firstElementChild;
  return root instanceof HTMLElement && root.scrollHeight > root.clientHeight ? root : page;
}

export function useRouteStack() {
  const [stack, setStack] = useState(initialStack);
  const pageRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ transition: ViewTransition; commit: () => void } | null>(null);

  // A second navigation may arrive before Chromium calls the snapshot's update.
  // Apply that pop exactly once, in input order, before handling the next one.
  const finishPop = useCallback(() => {
    const pop = pending.current;
    if (!pop) return;
    pending.current = null;
    pop.transition.skipTransition();
    pop.commit();
  }, []);

  const navigate = useCallback((view: ActiveView) => {
    finishPop();
    const page = isDeckLayout() ? pageRef.current : null;
    const visibleKey = page?.dataset.routePage;
    const scrollTop = page ? scroller(page).scrollTop : 0;
    const nextKey = routeKey(view);
    setStack(prev => {
      const currentKey = routeKey(prev.entry.view);
      if (currentKey === nextKey) return { ...prev, refreshKey: prev.refreshKey + 1 };
      const history = prev.history.slice(1 - historyLimit);
      history.push({ view: prev.entry.view, scrollTop: visibleKey === currentKey ? scrollTop : prev.entry.scrollTop });
      return { ...prev, entry: { view, scrollTop: 0 }, history, direction: 'forward' };
    });
  }, [finishPop]);

  const back = useCallback(() => {
    finishPop();
    const page = pageRef.current;
    if (!page?.hasAttribute('data-route-can-back')) return;
    let applied = false;
    const commit = () => {
      if (applied) return;
      applied = true;
      delete page.dataset.routeCapture;
      flushSync(() => setStack(prev => {
        const entry = prev.history.at(-1);
        return entry ? { ...prev, entry, history: prev.history.slice(0, -1), direction: 'back' } : prev;
      }));
    };
    if (!isDeckLayout() || !document.startViewTransition || !matchMedia('(prefers-reduced-motion: no-preference)').matches) {
      commit();
      return;
    }
    // Only the old viewport is captured. No second mounted page, menus, IDs or
    // focusable controls; the destination paints normally below its snapshot.
    page.dataset.routeCapture = '';
    const transition = document.startViewTransition({ types: ['route-back'], update: commit });
    pending.current = { transition, commit };
    void transition.finished.finally(() => {
      if (pending.current?.transition === transition) pending.current = null;
    });
  }, [finishPop]);

  const refresh = useCallback(() => setStack(prev => ({ ...prev, refreshKey: prev.refreshKey + 1 })), []);
  const reset = useCallback(() => {
    finishPop();
    setStack({ entry: { view: { type: 'home' }, scrollTop: 0 }, history: [], direction: 'initial', refreshKey: 0 });
  }, [finishPop]);
  return { ...stack, pageRef, navigate, back, refresh, reset };
}

export function RouteViewport({ entry, direction, pageRef, canGoBack, children }: {
  entry: Entry;
  direction: Direction;
  pageRef: RefObject<HTMLDivElement | null>;
  canGoBack: boolean;
  children: ReactNode;
}) {
  const key = routeKey(entry.view);
  const detail = entry.view.type === 'artist' || entry.view.type === 'album';
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || direction !== 'back' || !entry.scrollTop || !isDeckLayout()) return;
    const restore = () => {
      const el = scroller(page);
      el.scrollTo({ top: entry.scrollTop, behavior: 'instant' });
      return Math.abs(el.scrollTop - entry.scrollTop) < 1;
    };
    if (restore()) return;
    // Cached rows can mount immediately; a cold query or virtual table may
    // only acquire its measured height later. Never override a user's input.
    const input = new AbortController();
    const changes = new MutationObserver(() => { if (restore()) stop(); });
    const stop = () => {
      changes.disconnect();
      input.abort();
    };
    changes.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'aria-busy'] });
    for (const event of ['wheel', 'pointerdown', 'keydown']) {
      page.addEventListener(event, stop, { capture: true, passive: true, signal: input.signal });
    }
    return stop;
  }, [entry, direction, pageRef]);
  return (
    <div key={key} ref={pageRef} data-route-page={key} data-route-direction={direction}
      data-route-can-back={canGoBack || undefined} data-detail-viewport={detail || undefined}>
      <div data-route-content data-detail-route={detail ? key : undefined}>{children}</div>
    </div>
  );
}
