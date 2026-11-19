import type { YTMHomeSection } from '../api/yt';

type HomeRole = NonNullable<YTMHomeSection['homeRole']>;

interface HomeShelf {
  section: YTMHomeSection;
  role?: HomeRole;
  feedIndex: number;
}

// Exact legacy titles only. Current pages identify shelves independently of their UI text.
function legacyHomeRole(title: string | null): HomeRole | undefined {
  switch (title?.trim().toLowerCase().replace(/ё/g, 'е')) {
    case 'listen again':
    case 'слушать еще раз':
    case 'послушать еще раз':
    case 'послушайте еще раз': return 'listen-again';
    case 'quick picks':
    case 'быстрый выбор':
    case 'рекомендуем': return 'quick-picks';
  }
}

// Only the uninterrupted prefix of Listen again is pinned. Don't mutate the query cache.
function normalizeListenAgain(section: YTMHomeSection): YTMHomeSection {
  const firstUnpinned = section.contents.findIndex(item => !item.isPinned);
  if (firstUnpinned < 0) return section;
  let contents = section.contents;
  for (let i = firstUnpinned + 1; i < contents.length; i++) {
    if (!contents[i].isPinned) continue;
    if (contents === section.contents) contents = contents.slice();
    contents[i] = { ...contents[i], isPinned: false };
  }
  return contents === section.contents ? section : { ...section, contents };
}

export function orderHomeShelves(pages: readonly { sections: readonly YTMHomeSection[] }[]): HomeShelf[] {
  const shelves: HomeShelf[] = [];
  const chosen: Partial<Record<HomeRole, HomeShelf>> = {};
  for (const page of pages) {
    for (const section of page.sections) {
      const role = section.homeRole ?? legacyHomeRole(section.title);
      const shelf = {
        section: role === 'listen-again' ? normalizeListenAgain(section) : section,
        role,
        feedIndex: shelves.length,
      };
      shelves.push(shelf);
      if (role && (!chosen[role] || (section.homeRole && !chosen[role]?.section.homeRole))) {
        chosen[role] = shelf;
      }
    }
  }

  const listen = chosen['listen-again'];
  const quick = chosen['quick-picks'];
  if (!listen && !quick) return shelves;
  const result: HomeShelf[] = [];
  if (listen) result.push(listen);
  if (quick) result.push(quick);
  for (const shelf of shelves) {
    if (shelf !== listen && shelf !== quick) result.push(shelf);
  }
  return result;
}

export function nextHomeContinuation(token: string | null, requested: readonly (string | null)[]) {
  return token && !requested.includes(token) ? token : undefined;
}

// Quick picks can arrive on the fourth page. Don't crawl the whole feed for a missing shelf.
export function shouldSeekHomeShelves(pagesLoaded: number, ordered: readonly HomeShelf[]): boolean {
  return pagesLoaded > 0 && pagesLoaded < 5 &&
    (ordered[0]?.role !== 'listen-again' || ordered[1]?.role !== 'quick-picks');
}
