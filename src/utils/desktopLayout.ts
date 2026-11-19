const storageKey = 'goymusic-desktop-layout';
const layoutChanged = 'goymusic-desktop-layout-changed';
const nyanKey = 'goymusic-deck-nyan';

export const deckSpeeds = { ultra: 'Ultra fast', fast: 'Fast', medium: 'Medium', slow: 'Slow' } as const;
export const deckDimming = { light: 'Light', dim: 'Darker', original: 'Like Classic' } as const;
export const deckTimes = { right: 'Right side', tooltip: 'At cursor' } as const;
export const sidebarStyles = { new: 'New', classic: 'Classic' } as const;

function layoutChoice<T extends string>(attribute: string, choices: Record<T, string>, fallback: T | (() => T)) {
    const key = `goymusic-${attribute}`;
    const valid = (value: string | null): value is T => value !== null && Object.hasOwn(choices, value);
    const resolve = (value: string | null): T => {
        if (valid(value)) return value;
        return typeof fallback === 'function' ? fallback() : fallback;
    };
    return {
        read: () => resolve(document.documentElement.getAttribute(`data-${attribute}`)),
        restore: () => document.documentElement.setAttribute(`data-${attribute}`, resolve(localStorage.getItem(key))),
        set: (value: string) => {
            if (!valid(value)) return;
            localStorage.setItem(key, value);
            document.documentElement.setAttribute(`data-${attribute}`, value);
            window.dispatchEvent(new Event(layoutChanged));
        },
    };
}

export const deckSpeed = layoutChoice('deck-speed', deckSpeeds, 'medium');
export const deckDim = layoutChoice('deck-dim', deckDimming, 'light');
export const deckTime = layoutChoice('deck-time', deckTimes, 'right');
export const sidebarButtons = layoutChoice('sidebar-buttons', sidebarStyles, () => isDeckLayout() ? 'new' : 'classic');
export const sidebarWidth = layoutChoice('sidebar-width', sidebarStyles, 'new');

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
    deckSpeed.restore();
    deckDim.restore();
    deckTime.restore();
    const legacySize = localStorage.getItem('goymusic-deck-sidebar-size');
    if (legacySize !== null) {
        if (Object.hasOwn(sidebarStyles, legacySize) && localStorage.getItem('goymusic-sidebar-buttons') === null) {
            localStorage.setItem('goymusic-sidebar-buttons', legacySize);
        }
        localStorage.removeItem('goymusic-deck-sidebar-size');
    }
    localStorage.removeItem('goymusic-deck-nav-size');
    if (localStorage.getItem(nyanKey) === 'on') document.documentElement.dataset.nyan = 'on';
    const saved = localStorage.getItem(storageKey);
    if (saved === 'sleeve') localStorage.setItem(storageKey, 'deck');
    if (saved === 'deck' || saved === 'sleeve') document.documentElement.dataset.layout = 'deck';
    else delete document.documentElement.dataset.layout;
    sidebarButtons.restore();
    sidebarWidth.restore();
}

export function setDeckLayout(enabled: boolean) {
    if (enabled) {
        localStorage.setItem(storageKey, 'deck');
        document.documentElement.dataset.layout = 'deck';
    } else {
        localStorage.removeItem(storageKey);
        delete document.documentElement.dataset.layout;
    }
    sidebarButtons.restore();
    sidebarWidth.restore();
    window.dispatchEvent(new Event(layoutChanged));
}
