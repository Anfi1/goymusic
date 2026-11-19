import { describe, expect, it } from 'vitest';
import {
    SpectrumColumns, SPECTRUM_FLOOR_DB, frequencyAt, frequencyX, gainAt, gainY, hitBand,
    maxPlotFrequency, type Band,
} from './equalizer';

describe('equalizer plot and gestures', () => {
    it.each([32_000, 44_100, 48_000, 96_000])('never samples a folded shelf past Nyquist at %i Hz', rate => {
        const maxHz = maxPlotFrequency(rate);
        const frequencies = Float32Array.from({ length: 513 }, (_, i) => frequencyAt(i / 512, maxHz));
        expect(frequencies[0]).toBe(20);
        expect(frequencies[512]).toBe(Math.min(20_000, rate / 2));
        for (let i = 1; i < frequencies.length; i++) {
            expect(frequencies[i]).toBeGreaterThan(frequencies[i - 1]);
            expect(frequencyX(frequencies[i], maxHz)).toBeCloseTo(i / 512, 6);
        }
        expect(frequencyAt(1.1, maxHz)).toBe(maxHz);
        expect(frequencyAt(-0.1, maxHz)).toBe(20);
    });

    it.each([-24, 24])('grabs the actual shelf, not a nearby earlier peaking band, at %i dB', gain => {
        const bands: Band[] = [
            { type: 'peaking', frequency: 15_600, gain, Q: 1 },
            { type: 'highshelf', frequency: 16_000, gain, Q: 1 },
        ];
        for (const position of [19_800, 18_000, 14_500, 15_600, 16_100]) {
            bands[1].frequency = position;
            const x = frequencyX(position, 20_000) * 320;
            const y = gainY(gain) * 180;
            expect(hitBand(bands, x, y, 320, 180, 20_000)).toBe(1);
            expect(frequencyAt(x / 320, 20_000)).toBeCloseTo(position, 7);
            expect(gainAt(y / 180)).toBe(gain);
        }
    });
});

describe('post-EQ spectrum projection', () => {
    it.each([32_000, 44_100, 48_000, 96_000])('keeps narrow, high-frequency peaks and their dBFS level at %i Hz', rate => {
        const bins = new Float32Array(4096).fill(-Infinity);
        const columns = new SpectrumColumns(241, rate, bins.length);
        const toneBin = Math.round(12_345 / (rate / 8192));
        const toneHz = toneBin * rate / 8192;
        const index = Math.round(frequencyX(toneHz, maxPlotFrequency(rate)) * 240);
        bins[toneBin] = -18;
        expect(columns.read(bins)).toBe(true);
        expect(columns.levels[index]).toBe(-18);
        expect(columns.levels[index - 1]).toBe(SPECTRUM_FLOOR_DB);
        expect(columns.levels[index + 1]).toBe(SPECTRUM_FLOOR_DB);
        bins[toneBin] -= 12;
        columns.read(bins);
        expect(columns.levels[index]).toBe(-30);
        bins.fill(-Infinity);
        expect(columns.read(bins)).toBe(false);
        expect(columns.levels.every(db => db === SPECTRUM_FLOOR_DB)).toBe(true);
    });
});
