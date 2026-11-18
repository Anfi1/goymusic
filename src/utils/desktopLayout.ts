const storageKey = 'goymusic-desktop-layout';

export function restoreDesktopLayout() {
    if (localStorage.getItem(storageKey) === 'sleeve') {
        document.documentElement.dataset.layout = 'sleeve';
    }
}

export function setSleeveLayout(enabled: boolean) {
    if (enabled) {
        localStorage.setItem(storageKey, 'sleeve');
        document.documentElement.dataset.layout = 'sleeve';
    } else {
        localStorage.removeItem(storageKey);
        delete document.documentElement.dataset.layout;
    }
}
