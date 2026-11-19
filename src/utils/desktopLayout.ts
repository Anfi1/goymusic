const storageKey = 'goymusic-desktop-layout';
const layoutChanged = 'goymusic-desktop-layout-changed';
const nyanKey = 'goymusic-deck-nyan';

export function isDeckNyanEnabled(): boolean {
    return document.documentElement.dataset.nyan === 'on';
}

export function setDeckNyanEnabled(enabled: boolean) {
    if (enabled) {
        localStorage.setItem(nyanKey, 'on');
        document.documentElement.dataset.nyan = 'on';
    } else {
        localStorage.removeItem(nyanKey);
        delete document.documentElement.dataset.nyan;
    }
    window.dispatchEvent(new Event(layoutChanged));
}

export function isDeckLayout(): boolean {
    return document.documentElement.dataset.layout === 'deck';
}

export function subscribeDesktopLayout(notify: () => void): () => void {
    window.addEventListener(layoutChanged, notify);
    return () => window.removeEventListener(layoutChanged, notify);
}

export function restoreDesktopLayout() {
    if (localStorage.getItem(nyanKey) === 'on') document.documentElement.dataset.nyan = 'on';
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
