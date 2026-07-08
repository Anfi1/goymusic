import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, ChevronDown, Check, Plus, Trash2, RotateCcw } from 'lucide-react';
import { player } from '../../api/player';
import { IconButton } from '../atoms/IconButton';
import styles from './EqualizerView.module.css';
import {
    MIN_FREQ, MAX_FREQ, MIN_GAIN, MAX_GAIN, DEFAULT_Q,
    BAND_COLORS, getMagnitudeResponse,
} from '../../utils/equalizer';

// ── Fixed coordinate system like WebEq ──
// gain=-18 → y=0 (top), gain=0 → y=250 (center), gain=+18 → y=500 (bottom)
const EQ_W = 1000;
const EQ_H = 500;

interface Band {
    gain: number;
    frequency: number;
    type: BiquadFilterType;
    Q: number;
}

interface Preset {
    name: string;
    bands: Pick<Band, 'gain' | 'frequency' | 'type'>[];
}

const DEFAULT_BANDS: Band[] = [
    { frequency: 60, gain: 0, type: 'lowshelf', Q: DEFAULT_Q },
    { frequency: 250, gain: 0, type: 'peaking', Q: DEFAULT_Q },
    { frequency: 1000, gain: 0, type: 'peaking', Q: DEFAULT_Q },
    { frequency: 4000, gain: 0, type: 'peaking', Q: DEFAULT_Q },
    { frequency: 8000, gain: 0, type: 'peaking', Q: DEFAULT_Q },
    { frequency: 16000, gain: 0, type: 'highshelf', Q: DEFAULT_Q },
];

const FILTER_TYPES: BiquadFilterType[] = ['lowshelf', 'peaking', 'highshelf'];

// Map frequency/gain → canvas pixel (fixed 1000x500 system)
const getXfromFreq = (freq: number): number => {
    const minFreq = 20, maxFreq = 20000;
    const normalizedX = Math.log(freq / minFreq) / Math.log(maxFreq / minFreq);
    return normalizedX * EQ_W;
};

const getYfromGain = (gain: number): number => {
    const range = MAX_GAIN - MIN_GAIN; // 36
    return ((MAX_GAIN - gain) / range) * EQ_H;
};

const getGainFromY = (y: number): number => {
    const range = MAX_GAIN - MIN_GAIN;
    const normalized = (EQ_H - y) / EQ_H;
    return MAX_GAIN - normalized * range;
};

const getFreqFromX = (x: number): number => {
    const minFreq = 20, maxFreq = 20000;
    const normalizedX = x / EQ_W;
    return minFreq * Math.pow(maxFreq / minFreq, normalizedX);
};

// ── Canvas Visualizer ──

const CanvasVisualizer: React.FC<{
    bands: Band[];
    selectedBand: number | null;
    onBandSelect: (idx: number) => void;
    onBandDrag: (idx: number, freq: number, gain: number) => void;
    onBandAdd: (freq: number, gain: number) => void;
    onBandDelete: (idx: number) => void;
    onCurveAdjust: (idx: number, curve: number) => void;
}> = ({
    bands, selectedBand,
    onBandSelect, onBandDrag, onBandAdd, onBandDelete, onCurveAdjust,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animFrameRef = useRef<number>(0);
    const bandsRef = useRef(bands);
    const selectedRef = useRef(selectedBand);
    const dragRef = useRef<{ bandIdx: number } | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const cleanupDragRef = useRef<(() => void) | null>(null);

    bandsRef.current = bands;
    selectedRef.current = selectedBand;

    // ResizeObserver — keep the canvas pixel buffer in sync with its CSS size
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        resizeObserverRef.current = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            canvas.width = Math.floor(rect.width * dpr);
            canvas.height = Math.floor(rect.height * dpr);
        });
        resizeObserverRef.current.observe(canvas);
        return () => {
            resizeObserverRef.current?.disconnect();
        };
    }, []);

    // Safety net: remove any lingering document-level listeners on unmount
    useEffect(() => {
        return () => cleanupDragRef.current?.();
    }, []);

        // Compute gain at point x — true biquad curve for all filter types
    const computeCurveGain = useCallback((x: number): number => {
        let totalGain = 0;
        const bands = bandsRef.current;
        const fs = player.getAnalyzerSampleRate();
        for (const band of bands) {
            const Q = band.Q ?? DEFAULT_Q;
            const freq = getFreqFromX(x);
            totalGain += getMagnitudeResponse(freq, band, Q, fs);
        }
        return Math.max(MIN_GAIN, Math.min(MAX_GAIN, totalGain));
    }, []);

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const bands = bandsRef.current;
        const selected = selectedRef.current;

        // Background
        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        bgGrad.addColorStop(0, '#0c0c14');
        bgGrad.addColorStop(1, '#11111b');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        // ── Live spectrum curve (background layer, behind EQ grid) ──
        try {
            const analyzerData = player.getAnalyzerData();
            if (analyzerData.length > 0) {
                const nyquist = player.getAnalyzerSampleRate() / 2;
                const binCount = analyzerData.length;
                // Sample ~120 points across the frequency range (log scale)
                const POINTS = 120;
                const spec: number[] = [];

                for (let p = 0; p < POINTS; p++) {
                    const freq = 20 * Math.pow(1000, p / POINTS); // 20 Hz – 20 kHz
                    const bin = Math.round((freq / nyquist) * binCount);
                    if (bin >= binCount) { spec.push(0); continue; }
                    // Average a small window of bins for smoothness
                    let sum = 0;
                    let cnt = 0;
                    for (let b = Math.max(0, bin - 2); b <= Math.min(binCount - 1, bin + 2); b++) {
                        sum += analyzerData[b];
                        cnt++;
                    }
                    const avg = sum / cnt;
                    // Exponentiate for a musical feel (louder peaks stand out)
                    spec.push(Math.pow(avg / 255, 0.55));
                }

                // Simple moving-average smoothing
                const SMOOTH = 3;
                const smooth = spec.map((v, i) => {
                    let sum = 0;
                    let cnt = 0;
                    for (let j = i - SMOOTH; j <= i + SMOOTH; j++) {
                        if (j >= 0 && j < spec.length) { sum += spec[j]; cnt++; }
                    }
                    return sum / cnt;
                });

                // Build points: x = log freq position, y = height - amplitude
                const pts: [number, number][] = smooth.map((v, i) => {
                    const x = (i / (POINTS - 1)) * width;
                    const y = height - v * height * 0.55;
                    return [x, y];
                });

                // Fill under the curve
                ctx.beginPath();
                ctx.moveTo(pts[0][0], height);
                for (const [x, y] of pts) ctx.lineTo(x, y);
                ctx.lineTo(pts[pts.length - 1][0], height);
                ctx.closePath();
                const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
                fillGrad.addColorStop(0, 'rgba(137,180,250,0.16)');
                fillGrad.addColorStop(0.5, 'rgba(137,180,250,0.06)');
                fillGrad.addColorStop(1, 'rgba(137,180,250,0)');
                ctx.fillStyle = fillGrad;
                ctx.fill();

                // Stroke the spectrum line
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i][0], pts[i][1]);
                }
                ctx.strokeStyle = 'rgba(137,180,250,0.35)';
                ctx.lineWidth = 1.5;
                ctx.lineJoin = 'round';
                ctx.stroke();
            }
        } catch {
            // Analyzer not available (nothing playing)
        }

        // Scaling: fixed 1000x500 → canvas size
        const scaleX = width / EQ_W;
        const scaleY = height / EQ_H;

        // 0dB line (center)
        const zeroDbY = getYfromGain(0) * scaleY;
        ctx.beginPath();
        ctx.moveTo(0, zeroDbY);
        ctx.lineTo(width, zeroDbY);
        ctx.strokeStyle = 'rgba(137, 180, 250, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // dB lines + labels (extended to ±24 for shelf resonances)
        const dbValues = [24, 21, 18, 15, 12, 9, 6, 3, 0, -3, -6, -9, -12, -15, -18, -21, -24];
        for (const db of dbValues) {
            const svgY = getYfromGain(db);
            const y = svgY * scaleY;
            if (y < 8 || y > height - 8) continue;

            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            const isZero = db === 0;
            ctx.strokeStyle = isZero ? 'rgba(205,214,244,0.1)' : 'rgba(205,214,244,0.03)';
            ctx.lineWidth = 0.5;
            ctx.setLineDash([]);
            ctx.stroke();

            let label = db === 0 ? '0 dB' : `${db > 0 ? '+' : ''}${db}dB`;
            ctx.save();
            ctx.translate(8, y);
            ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
            const metrics = ctx.measureText(label);
            const pw = metrics.width + 12;
            const ph = 18;
            ctx.fillStyle = 'rgba(9, 9, 15, 0.75)';
            ctx.beginPath();
            ctx.roundRect(0, -ph / 2, pw, ph, 4);
            ctx.fill();
            ctx.fillStyle = isZero ? 'rgba(137,180,250,0.7)' : 'rgba(205,214,244,0.55)';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText(label, 6, 1);
            ctx.restore();
        }

        // Frequency lines + labels
        const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        for (const f of freqLabels) {
            const x = getXfromFreq(f) * scaleX;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.strokeStyle = 'rgba(205,214,244,0.03)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
            let label = f >= 1000 ? `${f / 1000}k` : `${f}`;
            label += 'Hz';
            ctx.save();
            ctx.translate(x, height - 18);
            ctx.font = '11px system-ui, -apple-system, sans-serif';
            ctx.fillStyle = 'rgba(205,214,244,0.35)';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'center';
            ctx.fillText(label, 0, 0);
            ctx.restore();
        }

        // Curve — like WebEq: from -100 to width+100
        // Fill gradient
        const step = 2;
        ctx.beginPath();
        ctx.moveTo(-100 * scaleX, zeroDbY);
        for (let i = 0; i <= EQ_W; i += step) {
            const px = i * scaleX;
            const gain = computeCurveGain(i);
            const py = getYfromGain(gain) * scaleY;
            ctx.lineTo(px, py);
        }
        ctx.lineTo((EQ_W + 1000) * scaleX, height + 100);
        ctx.lineTo(-100 * scaleX, height + 100);
        ctx.closePath();
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(137,180,250,0.15)');
        fillGrad.addColorStop(0.5, 'rgba(137,180,250,0.04)');
        fillGrad.addColorStop(1, 'rgba(137,180,250,0.0)');
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // Curve stroke
        ctx.beginPath();
        for (let i = 0; i <= EQ_W; i += step) {
            const px = i * scaleX;
            const gain = computeCurveGain(i);
            const py = getYfromGain(gain) * scaleY;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.save();
        ctx.shadowColor = 'rgba(137,180,250,0.5)';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = 'rgba(137,180,250,0.9)';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();

        // Points — like WebEq: arc(x, EQ_H - y, radius)
        for (let i = 0; i < bands.length; i++) {
            const band = bands[i];
            const px = getXfromFreq(band.frequency) * scaleX;
            const py = getYfromGain(band.gain) * scaleY;
            const isSelected = selected === i;
            const color = BAND_COLORS[i % BAND_COLORS.length];
            const radius = isSelected ? 8 : 6;

            // Dark backing so the point is visible on any background
            ctx.beginPath();
            ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(9, 9, 15, 0.6)';
            ctx.fill();

            // Track from point down to the 0dB line
            ctx.beginPath();
            ctx.moveTo(px, zeroDbY);
            ctx.lineTo(px, py);
            ctx.strokeStyle = color + (isSelected ? '60' : '30');
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.setLineDash(isSelected ? [] : [3, 3]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Glow
            if (isSelected) {
                const glowGrad = ctx.createRadialGradient(px, py, radius, px, py, 30);
                glowGrad.addColorStop(0, color + '50');
                glowGrad.addColorStop(1, color + '00');
                ctx.beginPath();
                ctx.arc(px, py, 30, 0, Math.PI * 2);
                ctx.fillStyle = glowGrad;
                ctx.fill();
                ctx.beginPath();
                ctx.arc(px, py, 18, 0, Math.PI * 2);
                ctx.strokeStyle = color + '55';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Main point
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            if (isSelected) {
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                ctx.fillStyle = color + 'bb';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.2)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

    }, [computeCurveGain]);

    // Animation loop — always render so the spectrum stays live
    useEffect(() => {
        const loop = () => {
            render();
            animFrameRef.current = requestAnimationFrame(loop);
        };
        animFrameRef.current = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [render]);

    // Mouse coords → SVG equalizer coords
    const getPointFromEvent = useCallback((e: React.MouseEvent): { freq: number; gain: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { freq: 1000, gain: 0 };
        const rect = canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * EQ_W;
        const y = EQ_H - ((e.clientY - rect.top) / rect.height) * EQ_H;
        return { freq: getFreqFromX(x), gain: getGainFromY(y) };
    }, []);

    const findBandAtPoint = useCallback((sx: number, sy: number): number => {
        const canvas = canvasRef.current;
        if (!canvas) return -1;
        const rect = canvas.getBoundingClientRect();
        const mouseX = sx - rect.left;
        const mouseY = sy - rect.top;
        const bands = bandsRef.current;
        const scaleX = rect.width / EQ_W;
        const scaleY = rect.height / EQ_H;
        let found = -1;
        for (let i = bands.length - 1; i >= 0; i--) {
            const bx = getXfromFreq(bands[i].frequency) * scaleX;
            const by = getYfromGain(bands[i].gain) * scaleY;
            const dist = Math.sqrt((mouseX - bx) ** 2 + (mouseY - by) ** 2);
            if (dist < 20) found = i;
        }
        return found;
    }, []);

    const handleDocumentMouseMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * EQ_W;
        const y = EQ_H - ((e.clientY - rect.top) / rect.height) * EQ_H;
        const { bandIdx } = dragRef.current;
        const nF = Math.max(MIN_FREQ, Math.min(MAX_FREQ, getFreqFromX(x)));
        const nG = Math.max(MIN_GAIN, Math.min(MAX_GAIN, getGainFromY(y)));
        onBandDrag(bandIdx, nF, nG);
    }, [onBandDrag]);

    const handleDocumentMouseUp = useCallback(() => {
        dragRef.current = null;
        document.removeEventListener('mousemove', handleDocumentMouseMove);
        document.removeEventListener('mouseup', handleDocumentMouseUp);
    }, [handleDocumentMouseMove]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        const idx = findBandAtPoint(e.clientX, e.clientY);
        if (idx !== -1) {
            onBandSelect(idx);
            dragRef.current = { bandIdx: idx };
            const onMove = handleDocumentMouseMove;
            const onUp = handleDocumentMouseUp;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            cleanupDragRef.current = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                cleanupDragRef.current = null;
            };
        }
    }, [findBandAtPoint, onBandSelect, handleDocumentMouseMove, handleDocumentMouseUp]);

    const handleDblClick = useCallback((e: React.MouseEvent) => {
        const idx = findBandAtPoint(e.clientX, e.clientY);
        if (idx !== -1) return;
        const pt = getPointFromEvent(e);
        onBandAdd(Math.max(MIN_FREQ, Math.min(MAX_FREQ, pt.freq)), Math.round(Math.max(MIN_GAIN, Math.min(MAX_GAIN, pt.gain)) * 2) / 2);
    }, [findBandAtPoint, getPointFromEvent, onBandAdd]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (selectedRef.current === null) return;
        e.preventDefault();
        const newQ = Math.max(0.1, Math.min(5, bandsRef.current[selectedRef.current].Q - e.deltaY / 100));
        onCurveAdjust(selectedRef.current, newQ);
    }, [onCurveAdjust]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const idx = findBandAtPoint(e.clientX, e.clientY);
        if (idx !== -1) onBandDelete(idx);
    }, [findBandAtPoint, onBandDelete]);

    return (
        <canvas
            ref={canvasRef}
            className={styles.canvas}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDblClick}
            onWheel={handleWheel}
            onContextMenu={handleContextMenu}
        />
    );
};

// ── EqualizerView (full-screen page) ──

export const EqualizerView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [bands, setBands] = useState<Band[]>(() => {
        const pb = player.getEQBands();
        if ((pb as any[])?.length > 0) return (pb as any[]).map((b: any) => ({ ...b, Q: b.Q ?? DEFAULT_Q }));
        return DEFAULT_BANDS;
    });
    const syncedRef = useRef(false);

    const [presets, setPresets] = useState<Preset[]>(() => {
        try { return JSON.parse(localStorage.getItem('ytm-eq-presets') || '[{"name":"Flat","bands":[]}]'); }
        catch { return [{ name: 'Flat', bands: [] }]; }
    });
    const [activePreset, setActivePreset] = useState(() => localStorage.getItem('ytm-eq-active') || 'Flat');
    const [selectedBand, setSelectedBand] = useState<number | null>(null);
    const [showPresets, setShowPresets] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (syncedRef.current) return;
        syncedRef.current = true;
        const pb = player.getEQBands();
        if ((pb as any[])?.length > 0) {
            const normalized = (pb as any[]).map((b: any) => ({ ...b, Q: b.Q ?? DEFAULT_Q }));
            setBands(normalized);
        }
    }, []);

    const handleBandSelect = useCallback((idx: number) => setSelectedBand(idx), []);

    const handleBandDrag = useCallback((idx: number, freq: number, gain: number) => {
        const nb = [...bands];
        nb[idx] = { ...nb[idx], frequency: freq, gain };
        setBands(nb);
        player.setBand(idx, gain, freq);
        setActivePreset('Custom');
    }, [bands]);

    const handleBandAdd = useCallback((freq: number, gain: number) => {
        player.addBand(freq, Math.round(gain * 2) / 2);
        setBands(prev => [...prev, { frequency: freq, gain: Math.round(gain * 2) / 2, type: 'peaking', Q: DEFAULT_Q }]);
    }, []);

    const handleBandDelete = useCallback((idx: number) => {
        player.removeBand(idx);
        setBands(prev => prev.filter((_, i) => i !== idx));
        if (selectedBand !== null && selectedBand >= idx) setSelectedBand(selectedBand > idx ? selectedBand - 1 : null);
    }, [selectedBand]);

    const handleCurveAdjust = useCallback((idx: number, Q: number) => {
        const nb = [...bands];
        nb[idx] = { ...nb[idx], Q };
        setBands(nb);
        player.setBand(idx, nb[idx].gain, nb[idx].frequency, nb[idx].type, Q);
    }, [bands]);

    const applyPreset = (p: Preset) => {
        setSelectedBand(null);
        if (!p.bands || p.bands.length === 0) {
            setBands(DEFAULT_BANDS);
            DEFAULT_BANDS.forEach((band, i) => player.setBand(i, band.gain, band.frequency, band.type));
        } else {
            const b = p.bands.map((b: any) => ({ ...b, Q: (b as Band).Q ?? DEFAULT_Q }));
            while ((player.getEQBands() as any[]).length < b.length) player.addBand(1000, 0);
            b.forEach((band, i) => player.setBand(i, band.gain, band.frequency, band.type));
            const currentBands = player.getEQBands();
            setBands((currentBands as any[]).length > 0 ? b.slice(0, (currentBands as any[]).length) : DEFAULT_BANDS);
        }
        setActivePreset(p.name);
        setShowPresets(false);
    };

    const handleSave = () => {
        if (!newPresetName.trim()) return;
        const name = newPresetName.trim();
        const np = [...presets.filter(p => p.name !== name), { name, bands: bands as Pick<Band, 'gain' | 'frequency' | 'type'>[] }];
        setPresets(np);
        setActivePreset(name);
        localStorage.setItem('ytm-eq-presets', JSON.stringify(np));
        localStorage.setItem('ytm-eq-active', name);
        setIsSaving(false);
        setNewPresetName('');
    };

    const deletePreset = (name: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (name === 'Flat') return;
        const nextPresets = presets.filter(p => p.name !== name);
        setPresets(nextPresets);
        if (activePreset === name) applyPreset(presets.find(p => p.name === 'Flat')!);
        localStorage.setItem('ytm-eq-presets', JSON.stringify(nextPresets));
    };

    const updateType = (type: BiquadFilterType) => {
        if (selectedBand === null) return;
        const nb = [...bands];
        nb[selectedBand] = { ...nb[selectedBand], type };
        setBands(nb);
        player.setBand(selectedBand, nb[selectedBand].gain, nb[selectedBand].frequency, type);
    };

    const handleAddBand = () => {
        player.addBand(1000, 0);
        setBands(prev => [...prev, { frequency: 1000, gain: 0, type: 'peaking', Q: DEFAULT_Q }]);
    };

    const handleReset = useCallback(() => {
        setBands(DEFAULT_BANDS);
        DEFAULT_BANDS.forEach((band, i) => player.setBand(i, band.gain, band.frequency, band.type));
        setActivePreset('Flat');
        setSelectedBand(null);
    }, []);

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Equalizer</h1>
                <div className={styles.spacer} />
                {!isSaving ? (
                    <div className={styles.presetWrap}>
                        <div className={styles.presetSelector}>
                            <button className={styles.presetBtn} onClick={() => setShowPresets(!showPresets)}>
                                {activePreset} <ChevronDown size={14} />
                            </button>
                            {showPresets && (
                                <div className={styles.presetsDropdown}>
                                    {presets.map(p => (
                                        <div key={p.name} className={styles.presetItem} onClick={() => applyPreset(p)}>
                                            <span>{p.name}</span>
                                            <div className={styles.presetActions}>
                                                {activePreset === p.name && <Check size={12} />}
                                                {p.name !== 'Flat' && (
                                                    <Trash2 size={12} className={styles.deleteIcon} onClick={(e) => deletePreset(p.name, e)} />
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <IconButton icon={Plus} size={36} iconSize={18} onClick={() => setIsSaving(true)} title="Save preset" />
                    </div>
                ) : (
                    <div className={styles.saveForm}>
                        <input autoFocus placeholder="Preset name..." value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} />
                        <IconButton icon={Check} size={36} onClick={handleSave} />
                        <IconButton icon={X} size={36} onClick={() => setIsSaving(false)} />
                    </div>
                )}
            </div>

            <div className={styles.visualizer}>
                <CanvasVisualizer
                    bands={bands}
                    selectedBand={selectedBand}
                    onBandSelect={handleBandSelect}
                    onBandDrag={handleBandDrag}
                    onBandAdd={handleBandAdd}
                    onBandDelete={handleBandDelete}
                    onCurveAdjust={handleCurveAdjust}
                />
            </div>

            <div className={styles.controls}>
                {selectedBand !== null && selectedBand < bands.length ? (
                    <div className={styles.bandEditor}>
                        <div className={styles.info}>
                            <span>Band {selectedBand + 1}</span>
                            <span>{Math.round(bands[selectedBand].frequency)}Hz / {bands[selectedBand].gain.toFixed(1)}dB</span>
                        </div>
                        <div className={styles.qControl}>
                            <span>Q</span>
                            <input
                                type="range"
                                min={0.1}
                                max={5}
                                step={0.01}
                                value={bands[selectedBand].Q ?? DEFAULT_Q}
                                onChange={(e) => handleCurveAdjust(selectedBand, Number(e.target.value))}
                            />
                            <span>{(bands[selectedBand].Q ?? DEFAULT_Q).toFixed(2)}</span>
                        </div>
                        <div className={styles.typeGrid}>
                            {FILTER_TYPES.map(t => (
                                <button key={t} className={`${styles.typeBtn} ${bands[selectedBand].type === t ? styles.typeActive : ''}`} onClick={() => updateType(t)}>
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <p className={styles.hint}>Drag to move · Double-click to add a band · Scroll to adjust Q · Spectrum shown on background</p>
                )}
                <div className={styles.bottomBar}>
                    <button className={styles.addBandBtn} onClick={handleAddBand}><Plus size={14} /> Add band</button>
                    <button className={styles.resetBtn} onClick={handleReset}><RotateCcw size={14} /> Reset</button>
                </div>
            </div>
        </div>
    );
};
