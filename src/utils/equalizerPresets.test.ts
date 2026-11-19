import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, EQ_SELECTION_KEY, FLAT_PRESET, readEqualizerState, SAVED_EQ_KEY } from './equalizerPresets';

const oldBand = { frequency: 140, gain: -2.5, type: 'lowshelf' };
const records = JSON.stringify([{ name: 'Flat', bands: [] }, { name: 'Rock', bands: [oldBand] }]);
function restore(values: Record<string, string>) {
    return readEqualizerState({ getItem: key => values[key] ?? null });
}

describe('equalizer restore', () => {
    it('keeps an older custom Rock distinct from the built-in and fills missing Q', () => {
        const storage = { [SAVED_EQ_KEY]: records, 'ytm-eq-active': 'Rock' };
        const legacy = restore(storage);
        expect(legacy.activeId).toBe('saved:Rock');
        expect(legacy.saved.map(p => p.name)).toEqual(['Rock']);
        expect(legacy.bands).toEqual([{ ...oldBand, Q: 1 }]);
        const builtin = BUILTIN_PRESETS.find(p => p.name === 'Rock')!;
        const current = restore({ ...storage, [EQ_SELECTION_KEY]: JSON.stringify(builtin.id) });
        expect(current.bands).toEqual(builtin.bands);
        expect(current.saved).toEqual(legacy.saved);
    });

    it('restores edited Q and an intentionally empty curve without falling back to Flat', () => {
        for (const bands of [[{ ...oldBand, Q: 2.7 }], []]) {
            const state = restore({ [SAVED_EQ_KEY]: records, [EQ_SELECTION_KEY]: JSON.stringify(bands) });
            expect(state.activeId).toBeNull();
            expect(state.bands).toEqual(bands);
            expect(state.saved[0].bands[0].Q).toBe(1);
        }
    });

    it('retains an explicitly saved empty Flat and handles a missing selection without playing another preset', () => {
        const saved = JSON.stringify([{ id: 'saved:Flat', name: 'Flat', bands: [] }]);
        const state = restore({ [SAVED_EQ_KEY]: saved, [EQ_SELECTION_KEY]: '"saved:deleted"' });
        expect(state.activeId).toBe(FLAT_PRESET.id);
        expect(state.bands).toEqual(FLAT_PRESET.bands);
        expect(state.saved).toEqual([{ id: 'saved:Flat', name: 'Flat', bands: [] }]);
    });
});
