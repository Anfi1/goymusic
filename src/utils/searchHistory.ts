const STORAGE_KEY = 'goymusic-search-history';
const MAX_ITEMS = 3;

export function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function addToSearchHistory(query: string) {
  const q = query.trim();
  if (!q) return;
  const history = getSearchHistory().filter(h => h.toLowerCase() !== q.toLowerCase());
  history.unshift(q);
  if (history.length > MAX_ITEMS) history.length = MAX_ITEMS;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function removeFromSearchHistory(query: string) {
  const history = getSearchHistory().filter(h => h !== query);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}
