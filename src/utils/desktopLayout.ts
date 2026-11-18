const storageKey = 'goymusic-desktop-layout';
const layoutChanged = 'goymusic-desktop-layout-changed';

export function isDeckLayout(): boolean {
    return document.documentElement.dataset.layout === 'deck';
}

export function subscribeDesktopLayout(notify: () => void): () => void {
    window.addEventListener(layoutChanged, notify);
    return () => window.removeEventListener(layoutChanged, notify);
}

export function restoreDesktopLayout() {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'sleeve') localStorage.setItem(storageKey, 'deck');
    if (saved === 'deck' || saved === 'sleeve') document.documentElement.dataset.layout = 'deck';
}

export function setDeckLayout(enabled: boolean) {
    if (enabled) {
        localStorage.setItem(storageKey, 'deck');
        document.documentElement.dataset.layout = 'deck';
    } else {
        localStorage.removeItem(storageKey);
        delete document.documentElement.dataset.layout;
    }
    window.dispatchEvent(new Event(layoutChanged));
}
