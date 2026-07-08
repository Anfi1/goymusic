// ── Constants ────────────────────────────────────────────────────────

export const MIN_FREQ = 20;
export const MAX_FREQ = 20_000;
export const MIN_GAIN = -24;
export const MAX_GAIN = 24;
export const ZERO_THRESHOLD = 0.5;
export const DEFAULT_Q = 1;
export const MAX_SCROLL = 200;

// Axis labels
export const FREQ_LABELS = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000];
export const DB_LABELS = [-18, -15, -12, -9, -6, -3, 0, 3, 6, 9];

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

// ── Coordinate helpers (log-frequency, dB-scaled) ───────────────────

export const getX = (freq: number, width: number): number =>
    (Math.log10(freq) - Math.log10(MIN_FREQ)) /
    (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ)) * width;

export const getY = (gain: number, height: number): number =>
    ((gain - MIN_GAIN) / (MAX_GAIN - MIN_GAIN)) * height;

export const getFreq = (x: number, width: number): number =>
    Math.pow(10, Math.log10(MIN_FREQ) + (x / width) * (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ)));

export const getGainFromY = (y: number, height: number): number => {
    const range = MAX_GAIN - MIN_GAIN;
    const normalized = 1 - (height - y) / height;
    return normalized * range + MIN_GAIN;
};

// ── Gaussian influence model (from WebEq) ────────────────────────────

export const gaussianInfluence = (dx: number, sigma: number): number =>
    Math.exp(-(dx * dx) / (2 * sigma * sigma));

/** Compute combined gain at a specific frequency from all bands. */
export const getGainAtFreq = (freq: number, bands: Band[]): number => {
    let totalGain = 0;
    bands.forEach(band => {
        const Q = band.Q ?? DEFAULT_Q;
        totalGain += getMagnitudeResponse(freq, band, Q);
    });
    return totalGain;
};

/** Compute SVG path string for the combined EQ curve. */
export const computeCurvePath = (bands: Band[], width: number, height: number): string => {
    const pts: string[] = [];
    for (let x = 0; x <= width; x++) {
        const freq = getFreq(x, width);
        const magDb = getGainAtFreq(freq, bands);
        const clamped = Math.max(MIN_GAIN, Math.min(MAX_GAIN, magDb));
        const y = getY(clamped, height);
        pts.push(`${x},${y}`);
    }
    return `M${pts.join(' L')}`;
};

// ── Biquad magnitude response (for audio processing) ─────────────────

export const getMagnitudeResponse = (f: number, band: Band, Q: number = 1, fs: number = 44_100): number => {
    const w0 = (2 * Math.PI * band.frequency) / fs;
    const A = Math.pow(10, band.gain / 40);

    // Q only affects peaking/notch; shelf filters use a fixed transition slope
    const effectiveQ = band.type === 'peaking' || band.type === 'notch' ? Q : Math.SQRT2 / 2;
    const alpha = Math.sin(w0) / (2 * effectiveQ);

    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

    if (band.type === 'peaking') {
        b0 = 1 + alpha * A; b1 = -2 * Math.cos(w0); b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * Math.cos(w0); a2 = 1 - alpha / A;
    } else if (band.type === 'lowshelf') {
        const sA = Math.sqrt(A);
        b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + 2 * sA * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * sA * alpha);
        a0 = (A + 1) + (A - 1) * Math.cos(w0) + 2 * sA * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0));
        a2 = (A + 1) + (A - 1) * Math.cos(w0) - 2 * sA * alpha;
    } else if (band.type === 'highshelf') {
        const sA = Math.sqrt(A);
        b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * sA * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * sA * alpha);
        a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * sA * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
        a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * sA * alpha;
    } else {
        return 0;
    }

    const phi = (2 * Math.PI * f) / fs;
    const cp = Math.cos(phi), cp2 = Math.cos(2 * phi);
    const sp = Math.sin(phi), sp2 = Math.sin(2 * phi);
    const nr = b0 + b1 * cp + b2 * cp2;
    const ni = b1 * sp + b2 * sp2;
    const dr = a0 + a1 * cp + a2 * cp2;
    const di = a1 * sp + a2 * sp2;
    const magnitude = Math.sqrt((nr ** 2 + ni ** 2) / (dr ** 2 + di ** 2));
    return 20 * Math.log10(Math.max(1e-10, magnitude));
};
