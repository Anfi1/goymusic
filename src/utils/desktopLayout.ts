const storageKey = 'goymusic-desktop-layout';
const layoutChanged = 'goymusic-desktop-layout-changed';
const nyanKey = 'goymusic-deck-nyan';

export const deckSpeeds = { ultra: 'Ultra fast', fast: 'Fast', medium: 'Medium', slow: 'Slow' } as const;
export const deckDimming = { light: 'Light', dim: 'Darker', original: 'Like Classic' } as const;
export const deckTimes = { right: 'Right side', tooltip: 'At cursor' } as const;

function deckChoice<T extends string>(attribute: string, choices: Record<T, string>, fallback: T) {
    const key = `goymusic-${attribute}`;
    const valid = (value: string | null): value is T => value !== null && Object.hasOwn(choices, value);
    return {
        read: (): T => {
            const value = document.documentElement.getAttribute(`data-${attribute}`);
            return valid(value) ? value : fallback;
        },
        restore: () => {
            const value = localStorage.getItem(key);
            document.documentElement.setAttribute(`data-${attribute}`, valid(value) ? value : fallback);
        },
        set: (value: string) => {
            if (!valid(value)) return;
            localStorage.setItem(key, value);
            document.documentElement.setAttribute(`data-${attribute}`, value);
            window.dispatchEvent(new Event(layoutChanged));
        },
    };
}

export const deckSpeed = deckChoice('deck-speed', deckSpeeds, 'medium');
export const deckDim = deckChoice('deck-dim', deckDimming, 'light');
export const deckTime = deckChoice('deck-time', deckTimes, 'right');
export const deckNavSize = deckChoice<'compact' | 'queue'>('deck-nav-size', { compact: 'Compact', queue: 'Match queue' }, 'compact');

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
    deckNavSize.restore();
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
