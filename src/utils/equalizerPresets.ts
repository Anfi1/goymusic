import { DEFAULT_Q, type Band } from './equalizer';

export interface EqualizerPreset {
    id: string;
    name: string;
    bands: Band[];
}

export interface EqualizerState {
    activeId: string | null;
    bands: Band[];
    saved: EqualizerPreset[];
}

const band = (frequency: number, gain: number, type: BiquadFilterType = 'peaking', Q = DEFAULT_Q): Band =>
    ({ frequency, gain, type, Q });

export const FLAT_PRESET: EqualizerPreset = {
    id: 'builtin:flat', name: 'Flat', bands: [
        band(60, 0, 'lowshelf'), band(250, 0), band(1000, 0),
        band(4000, 0), band(8000, 0), band(16000, 0, 'highshelf'),
    ],
};

export const BUILTIN_PRESETS: EqualizerPreset[] = [
    FLAT_PRESET,
    { id: 'builtin:bass', name: 'Bass Boost', bands: [band(105, 4, 'lowshelf'), band(290, -1.5, 'peaking', 0.9)] },
    { id: 'builtin:rock', name: 'Rock', bands: [band(95, 2.5, 'lowshelf'), band(450, -2, 'peaking', 0.85), band(2600, 1.5), band(7200, 2, 'highshelf')] },
    { id: 'builtin:vocals', name: 'Vocal Focus', bands: [band(140, -3, 'lowshelf'), band(450, -1), band(2100, 2.5, 'peaking', 0.75)] },
    { id: 'builtin:warm', name: 'Warm', bands: [band(210, 1.5, 'peaking', 0.7), band(4900, -2.5, 'highshelf')] },
];

export const SAVED_EQ_KEY = 'ytm-eq-presets';
export const EQ_SELECTION_KEY = 'ytm-eq-selection';

export function savedPreset(name: string, bands: Band[]): EqualizerPreset {
    return { id: `saved:${name}`, name, bands };
}

// Presets saved by older versions did not always include Q.
function readBands(value: unknown): Band[] | null {
    if (!Array.isArray(value)) return null;
    const bands: Band[] = [];
    for (const item of value) {
        if (!item || !Number.isFinite(item.frequency) || !Number.isFinite(item.gain) ||
            !['lowshelf', 'peaking', 'highshelf'].includes(item.type)) return null;
        bands.push(band(item.frequency, item.gain, item.type, Number.isFinite(item.Q) ? item.Q : DEFAULT_Q));
    }
    return bands;
}

function readJSON(storage: Pick<Storage, 'getItem'>, key: string): unknown {
    try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; }
}

export function readEqualizerState(storage: Pick<Storage, 'getItem'>): EqualizerState {
    const records = readJSON(storage, SAVED_EQ_KEY);
    const saved: EqualizerPreset[] = [];
    if (Array.isArray(records)) {
        for (const record of records) {
            if (typeof record?.name !== 'string') continue;
            const bands = readBands(record.bands);
            if (!bands) continue;
            // The old selector seeded every library with this empty built-in entry.
            if (!record.id && record.name === 'Flat' && bands.length === 0) continue;
            saved.push(savedPreset(record.name, bands));
        }
    }

    const selection = readJSON(storage, EQ_SELECTION_KEY);
    if (Array.isArray(selection)) {
        const bands = readBands(selection);
        if (bands) return { activeId: null, bands, saved };
    }
    let preset: EqualizerPreset | undefined;
    if (typeof selection === 'string') {
        preset = BUILTIN_PRESETS.find(p => p.id === selection) ?? saved.find(p => p.id === selection);
    } else {
        const legacyName = storage.getItem('ytm-eq-active');
        preset = saved.find(p => p.name === legacyName);
    }
    preset ??= FLAT_PRESET;
    return { activeId: preset.id, bands: preset.bands, saved };
}
