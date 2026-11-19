import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { restoreDesktopLayout, setDeckLayout, sidebarButtons, sidebarWidth } from './desktopLayout';

beforeEach(() => {
    const saved = new Map<string, string>();
    const attributes = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: saved.set.bind(saved),
        removeItem: saved.delete.bind(saved),
    });
    vi.stubGlobal('document', { documentElement: {
        dataset: {},
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: attributes.set.bind(attributes),
    } });
    vi.stubGlobal('window', new EventTarget());
});

afterEach(() => { vi.unstubAllGlobals(); });

it('follows the layout only for unset buttons, independently of the width', () => {
    restoreDesktopLayout();
    const root = document.documentElement;
    expect(root.getAttribute('data-sidebar-buttons')).toBe('classic');
    expect(root.getAttribute('data-sidebar-width')).toBe('new');

    sidebarWidth.set('classic');
    setDeckLayout(true);
    expect(root.getAttribute('data-sidebar-buttons')).toBe('new');
    expect(root.getAttribute('data-sidebar-width')).toBe('classic');

    sidebarButtons.set('classic');
    sidebarWidth.set('new');
    setDeckLayout(false);
    setDeckLayout(true);
    restoreDesktopLayout();
    expect(root.getAttribute('data-sidebar-buttons')).toBe('classic');
    expect(root.getAttribute('data-sidebar-width')).toBe('new');
});

it('migrates the old size to buttons only and discards the old font choice', () => {
    localStorage.setItem('goymusic-desktop-layout', 'deck');
    localStorage.setItem('goymusic-deck-sidebar-size', 'classic');
    localStorage.setItem('goymusic-deck-nav-size', 'queue');
    restoreDesktopLayout();
    expect(sidebarButtons.read()).toBe('classic');
    expect(sidebarWidth.read()).toBe('new');
    expect(localStorage.getItem('goymusic-sidebar-buttons')).toBe('classic');
    expect(localStorage.getItem('goymusic-deck-sidebar-size')).toBeNull();
    expect(localStorage.getItem('goymusic-deck-nav-size')).toBeNull();
});
