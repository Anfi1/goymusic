// ── Constants ────────────────────────────────────────────────────────

export const MIN_FREQ = 20;
export const MAX_FREQ = 20_000;
export const MIN_GAIN = -24;
export const MAX_GAIN = 24;
export const DEFAULT_Q = 1;
export const SPECTRUM_FLOOR_DB = -90;
export const FREQ_LABELS = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000];

// Per-band colours
export const BAND_COLORS: readonly string[] = [
    '#72efdd', '#89b4fa', '#cba6f7', '#fab387',
    '#a6e3a1', '#f38ba8', '#94e2d5', '#b4befe',
    '#f5c2e7', '#f9e2af', '#89dceb', '#eba0ac',
];

// ── Types ───────────────────────────────────────────────────────────

export interface Band {
    gain: number;
    frequency: number;
    type: BiquadFilterType;
    Q: number;
}

export function maxPlotFrequency(sampleRate: number) {
    return sampleRate > 0 ? Math.min(MAX_FREQ, sampleRate / 2) : MAX_FREQ;
}

/** Normalized coordinates within the plotting area: left/top = 0, right/bottom = 1. */
export function frequencyAt(x: number, maxHz: number) {
    if (x <= 0) return MIN_FREQ;
    if (x >= 1) return maxHz;
    return MIN_FREQ * (maxHz / MIN_FREQ) ** x;
}

export function frequencyX(hz: number, maxHz: number) {
    return Math.log(Math.min(maxHz, Math.max(MIN_FREQ, hz)) / MIN_FREQ) / Math.log(maxHz / MIN_FREQ);
}

export const gainY = (db: number) => (MAX_GAIN - db) / (MAX_GAIN - MIN_GAIN);
export const gainAt = (y: number) => MAX_GAIN - Math.max(0, Math.min(1, y)) * (MAX_GAIN - MIN_GAIN);

/** Prefer the nearest handle; on a tie, grab the topmost (last drawn). */
export function hitBand(bands: readonly Band[], x: number, y: number, width: number, height: number, maxHz: number) {
    let hit = -1;
    let distance = 16 ** 2;
    for (let i = bands.length - 1; i >= 0; i--) {
        const dx = frequencyX(bands[i].frequency, maxHz) * width - x;
        const dy = gainY(bands[i].gain) * height - y;
        const d = dx * dx + dy * dy;
        if (d < distance) { hit = i; distance = d; }
    }
    return hit;
}

/** Reuse this map until the log axis, sample rate or FFT size changes.
 * Wide columns keep their loudest bin (a narrow tone must not fall between samples).
 * Sub-bin columns interpolate adjacent bin centres rather than implying extra resolution.
 */
export class SpectrumColumns {
    readonly levels: Float32Array;
    private readonly first: Uint32Array;
    private readonly last: Uint32Array;
    private readonly fraction: Float32Array;

    constructor(count: number, sampleRate: number, bins: number) {
        this.levels = new Float32Array(count);
        this.first = new Uint32Array(count);
        this.last = new Uint32Array(count);
        this.fraction = new Float32Array(count);
        const maxHz = maxPlotFrequency(sampleRate);
        const hzPerBin = sampleRate / (2 * bins);
        for (let i = 0; i < count; i++) {
            const lo = Math.ceil(frequencyAt((i - 0.5) / (count - 1), maxHz) / hzPerBin);
            const hi = i === count - 1 ? Math.floor(maxHz / hzPerBin) + 1
                : Math.ceil(frequencyAt((i + 0.5) / (count - 1), maxHz) / hzPerBin);
            const pos = Math.min(bins - 1, frequencyAt(i / (count - 1), maxHz) / hzPerBin);
            if (hi > lo) {
                this.first[i] = Math.min(bins - 1, lo);
                this.last[i] = Math.min(bins - 1, hi - 1);
                this.fraction[i] = -1;
            } else {
                this.first[i] = Math.floor(pos);
                this.last[i] = Math.ceil(pos);
                this.fraction[i] = pos - Math.floor(pos);
            }
        }
    }

    /** Returns false for digital silence / signal below the displayed noise floor. */
    read(bins: Float32Array) {
        let visible = false;
        for (let i = 0; i < this.levels.length; i++) {
            const a = this.first[i], b = this.last[i], t = this.fraction[i];
            let db = Math.max(SPECTRUM_FLOOR_DB, bins[a]);
            if (t < 0) {
                for (let j = a + 1; j <= b; j++) db = Math.max(db, bins[j]);
            } else {
                db += (Math.max(SPECTRUM_FLOOR_DB, bins[b]) - db) * t;
            }
            this.levels[i] = Math.min(0, db);
            if (db > SPECTRUM_FLOOR_DB) visible = true;
        }
        return visible;
    }
}
