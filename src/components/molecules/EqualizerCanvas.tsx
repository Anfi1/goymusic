import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { player } from '../../api/player';
import {
    BAND_COLORS, DEFAULT_Q, FREQ_LABELS, MAX_GAIN, MIN_GAIN, SPECTRUM_FLOOR_DB,
    SpectrumColumns, frequencyAt, frequencyX, gainAt, gainY, hitBand, maxPlotFrequency, type Band,
} from '../../utils/equalizer';

interface Props {
    className: string;
    bands: readonly Band[];
    selectedBand: number | null;
    onBandSelect: (index: number) => void;
    onBandDrag: (index: number, hz: number, db: number) => void;
    onBandAdd: (hz: number, db: number) => void;
    onBandDelete: (index: number) => void;
    onCurveAdjust: (index: number, q: number) => void;
    onCursorChange?: (cursor: string) => void;
}

// Keep room for two independent level scales, axis labels and draggable edge handles.
const LEFT = 36, RIGHT = 36, TOP = 22, BOTTOM = 24;
const INNER_WIDTH = (width: number) => Math.max(1, width - LEFT - RIGHT);
const INNER_HEIGHT = (height: number) => Math.max(1, height - TOP - BOTTOM);

function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, maxHz: number,
                     response: Float32Array, { bands, selectedBand }: Props, hovered: number) {
    const right = LEFT + w, bottom = TOP + h;
    ctx.clearRect(0, 0, right + RIGHT, bottom + BOTTOM);
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ced2d8';
    ctx.fillText('dB', LEFT - 7, TOP - 12);
    for (let db = MIN_GAIN; db <= MAX_GAIN; db += h >= 200 ? 6 : 12) {
        const y = TOP + gainY(db) * h;
        ctx.fillText(db > 0 ? `+${db}` : String(db), LEFT - 7, y);
        ctx.strokeStyle = db === 0 ? '#6d7076' : '#34373b';
        ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(right, y); ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#77c5c1';
    ctx.fillText('dBFS', right + 5, TOP - 12);
    for (let db = 0; db >= SPECTRUM_FLOOR_DB; db -= 30) {
        ctx.fillText(String(db), right + 5, TOP + (db / SPECTRUM_FLOOR_DB) * h);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#b3b5b9';
    const activeIndex = hovered >= 0 ? hovered : selectedBand;
    const active = activeIndex === null ? undefined : bands[activeIndex];
    const activeX = active ? LEFT + frequencyX(active.frequency, maxHz) * w : -Infinity;
    let previousLabelX = -Infinity;
    const freqTick = (hz: number) => {
        const x = LEFT + frequencyX(hz, maxHz) * w;
        ctx.strokeStyle = 'rgba(180,190,195,0.11)';
        ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, bottom); ctx.stroke();
        if (Math.abs(x - activeX) >= 32 && (hz === maxHz || (x - previousLabelX >= 32 && right - x >= 32))) {
            ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x, bottom + 13);
            previousLabelX = x;
        }
    };
    for (const hz of FREQ_LABELS) if (hz < maxHz) freqTick(hz);
    freqTick(maxHz);
    ctx.fillText('Hz', right + 21, bottom + 13);
    if (active && activeIndex !== null) {
        ctx.fillStyle = BAND_COLORS[activeIndex % BAND_COLORS.length];
        ctx.fillRect(activeX - 1, bottom, 2, 5);
        ctx.fillText(String(Math.round(active.frequency)), activeX, bottom + 13);
    }

    // Clip, don't clamp: adjacent samples outside the displayed range are not a shelf plateau.
    ctx.save();
    ctx.beginPath(); ctx.rect(LEFT, TOP - 1, w, h + 2); ctx.clip();
    ctx.strokeStyle = '#f3f4f5'; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < response.length; i++) {
        const x = LEFT + i * w / (response.length - 1), y = TOP + gainY(response[i]) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.restore();

    // A shelf handle is its configured gain, NOT the measured gain at its turnover.
    // Do not draw a vertical stem crossing the response; it looks like a notch.
    for (let i = 0; i < bands.length; i++) {
        const x = LEFT + frequencyX(bands[i].frequency, maxHz) * w;
        const y = TOP + gainY(bands[i].gain) * h;
        const selected = selectedBand === i;
        const color = BAND_COLORS[i % BAND_COLORS.length];
        if (selected) {
            ctx.strokeStyle = color; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 12, 0, 2 * Math.PI); ctx.stroke();
        }
        ctx.fillStyle = color; ctx.strokeStyle = '#202124'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, selected || i === hovered ? 7 : 6, 0, 2 * Math.PI);
        ctx.fill(); ctx.stroke();
    }
}

export function EqualizerCanvas(props: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const current = useRef(props);
    current.current = props;
    const drag = useRef<{ index: number; dx: number; dy: number; pointerId: number } | null>(null);
    const hover = useRef(-1);

    useEffect(() => {
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d');
        const overlay = document.createElement('canvas');
        const grid = overlay.getContext('2d');
        if (!ctx || !grid) return;
        // Restored filters must be available even before a track is playing.
        void player.initAudioContext();
        let width = canvas.clientWidth, height = canvas.clientHeight;
        const observer = new ResizeObserver(([entry]) => {
            width = entry.contentRect.width; height = entry.contentRect.height;
        });
        observer.observe(canvas);
        let frame = 0, sampleRate = -1, maxHz = 0, revision = -1, binCount = 0, dpr = 0;
        let lastBands: readonly Band[] | undefined, lastSelected: Props['selectedBand'] | undefined;
        let lastHovered = -1;
        let frequencies = new Float32Array(0), response = new Float32Array(0);
        let magnitude = new Float32Array(0), phase = new Float32Array(0);
        let columns: SpectrumColumns | undefined;
        let wasVisible = false;
        const render = () => {
            frame = requestAnimationFrame(render);
            if (width <= 0 || height <= 0) return;
            const ratio = window.devicePixelRatio || 1;
            const pixelW = Math.round(width * ratio), pixelH = Math.round(height * ratio);
            const resized = canvas.width !== pixelW || canvas.height !== pixelH || dpr !== ratio;
            const rate = player.getAnalyzerSampleRate();
            const w = INNER_WIDTH(width), h = INNER_HEIGHT(height);
            const axisChanged = resized || sampleRate !== rate;
            if (resized) {
                canvas.width = overlay.width = pixelW; canvas.height = overlay.height = pixelH;
                ctx.setTransform(ratio, 0, 0, ratio, 0, 0); grid.setTransform(ratio, 0, 0, ratio, 0, 0);
                dpr = ratio;
            }
            if (axisChanged) {
                sampleRate = rate; maxHz = maxPlotFrequency(rate);
                const count = Math.max(2, Math.ceil(w) + 1);
                frequencies = new Float32Array(count); response = new Float32Array(count);
                magnitude = new Float32Array(count); phase = new Float32Array(count);
                for (let i = 0; i < count; i++) frequencies[i] = frequencyAt(i / (count - 1), maxHz);
                columns = undefined;
            }
            const nextRevision = player.getEQRevision();
            const changed = axisChanged || revision !== nextRevision;
            if (changed) {
                player.readEQResponse(frequencies, response, magnitude, phase);
                revision = nextRevision;
            }
            const p = current.current;
            const hovered = drag.current?.index ?? hover.current;
            const dirty = changed || lastBands !== p.bands || lastSelected !== p.selectedBand || lastHovered !== hovered;
            if (dirty) {
                drawOverlay(grid, w, h, maxHz, response, p, hovered);
                lastBands = p.bands; lastSelected = p.selectedBand; lastHovered = hovered;
            }
            const bins = player.getAnalyzerData();
            if (bins && (!columns || binCount !== bins.length)) {
                binCount = bins.length;
                columns = new SpectrumColumns(Math.max(2, Math.ceil(w / 2) + 1), rate, binCount);
            }
            const visible = Boolean(bins && columns?.read(bins));
            if (!dirty && !visible && !wasVisible) return;
            wasVisible = visible;
            ctx.fillStyle = '#191b1d'; ctx.fillRect(0, 0, width, height);
            if (visible && columns) {
                const levels = columns.levels;
                ctx.beginPath();
                for (let i = 0; i < levels.length; i++) {
                    const x = LEFT + w * i / (levels.length - 1), y = TOP + h * levels[i] / SPECTRUM_FLOOR_DB;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = '#77c5c1'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
                ctx.lineTo(LEFT + w, TOP + h); ctx.lineTo(LEFT, TOP + h); ctx.closePath();
                ctx.fillStyle = 'rgba(90,190,182,0.15)'; ctx.fill();
            }
            ctx.drawImage(overlay, 0, 0, width, height);
        };
        render();
        const wheel = (event: WheelEvent) => {
            const { selectedBand, bands, onCurveAdjust } = current.current;
            if (selectedBand === null || !bands[selectedBand]) return;
            event.preventDefault();
            onCurveAdjust(selectedBand, Math.max(0.1, Math.min(5, (bands[selectedBand].Q ?? DEFAULT_Q) - event.deltaY / 100)));
        };
        canvas.addEventListener('wheel', wheel, { passive: false });
        return () => {
            observer.disconnect(); cancelAnimationFrame(frame);
            canvas.removeEventListener('wheel', wheel);
        };
    }, []);

    const point = (e: ReactMouseEvent<HTMLCanvasElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const width = e.currentTarget.clientWidth, height = e.currentTarget.clientHeight;
        const w = INNER_WIDTH(width), h = INNER_HEIGHT(height);
        const x = (e.clientX - rect.left) * width / rect.width - LEFT;
        const y = (e.clientY - rect.top) * height / rect.height - TOP;
        const maxHz = maxPlotFrequency(player.getAnalyzerSampleRate());
        return { x, y, w, h, maxHz, hit: hitBand(props.bands, x, y, w, h, maxHz) };
    };
    const cursor = (canvas: HTMLCanvasElement, value: string) => {
        if (canvas.style.cursor === value) return;
        canvas.style.cursor = value;
        props.onCursorChange?.(value);
    };
    const selected = props.selectedBand === null ? undefined : props.bands[props.selectedBand];
    return <canvas ref={canvasRef} className={props.className} style={{ touchAction: 'none' }}
        aria-label={'Equalizer: filter response in dB and live output spectrum in dBFS' +
            (selected ? `; selected frequency ${Math.round(selected.frequency)} Hz` : '')}
        onPointerDown={e => {
            if (e.button !== 0 || !e.isPrimary) return;
            const { x, y, w, h, maxHz, hit } = point(e);
            if (hit < 0) return;
            const band = props.bands[hit];
            drag.current = { index: hit, dx: frequencyX(band.frequency, maxHz) * w - x,
                dy: gainY(band.gain) * h - y, pointerId: e.pointerId };
            e.currentTarget.setPointerCapture(e.pointerId);
            props.onBandSelect(hit); cursor(e.currentTarget, 'grabbing');
        }}
        onPointerMove={e => {
            const { x, y, w, h, maxHz, hit } = point(e);
            const d = drag.current;
            if (d && d.pointerId === e.pointerId) {
                props.onBandDrag(d.index, frequencyAt((x + d.dx) / w, maxHz), gainAt((y + d.dy) / h));
            } else if (!d) {
                hover.current = hit;
                cursor(e.currentTarget, hit >= 0 ? 'grab' : 'crosshair');
            }
        }}
        onPointerLeave={() => { hover.current = -1; }}
        onLostPointerCapture={e => {
            drag.current = null;
            hover.current = e.pointerType === 'mouse' ? point(e).hit : -1;
            cursor(e.currentTarget, hover.current >= 0 ? 'grab' : 'crosshair');
        }}
        onDoubleClick={e => {
            const { x, y, w, h, maxHz, hit } = point(e);
            if (hit < 0 && x >= 0 && x <= w && y >= 0 && y <= h)
                props.onBandAdd(frequencyAt(x / w, maxHz), Math.round(gainAt(y / h) * 2) / 2);
        }}
        onContextMenu={e => {
            e.preventDefault();
            const { hit } = point(e);
            hover.current = -1;
            if (hit >= 0) props.onBandDelete(hit);
        }}
    />;
}
