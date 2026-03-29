import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SlidersHorizontal, Trash2, ChevronDown, Check, X as CloseIcon, Plus } from 'lucide-react';
import { player } from '../../api/player';
import { IconButton } from '../atoms/IconButton';
import styles from './EqualizerMenu.module.css';

interface Band {
    gain: number;
    frequency: number;
    type: BiquadFilterType;
}

interface Preset {
    name: string;
    bands: Band[];
}

const DEFAULT_BANDS: Band[] = [
    { frequency: 60, gain: 0, type: 'lowshelf' },
    { frequency: 250, gain: 0, type: 'peaking' },
    { frequency: 1000, gain: 0, type: 'peaking' },
    { frequency: 4000, gain: 0, type: 'peaking' },
    { frequency: 8000, gain: 0, type: 'peaking' },
    { frequency: 16000, gain: 0, type: 'highshelf' },
];

const FILTER_TYPES: BiquadFilterType[] = ['lowshelf', 'peaking', 'highshelf'];
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MAX_GAIN = 15;

// HELPER FUNCTIONS
const getX = (freq: number, width: number) => (Math.log10(freq) - Math.log10(MIN_FREQ)) / (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ)) * width;
const getY = (gain: number, height: number) => height / 2 - (gain / MAX_GAIN) * (height / 2);
const getFreq = (x: number, width: number) => Math.pow(10, Math.log10(MIN_FREQ) + (x / width) * (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ)));
const getGainFromY = (y: number, height: number) => Math.max(-MAX_GAIN, Math.min(MAX_GAIN, ((height / 2 - y) / (height / 2)) * MAX_GAIN));

const getMagnitudeResponse = (f: number, band: Band): number => {
    const fs = 44100;
    const w0 = 2 * Math.PI * band.frequency / fs;
    const alpha = Math.sin(w0) / 2;
    const A = Math.pow(10, band.gain / 40);
    let b0, b1, b2, a0, a1, a2;

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
    } else return 0;

    const phi = 2 * Math.PI * f / fs;
    const cp = Math.cos(phi), cp2 = Math.cos(2 * phi), sp = Math.sin(phi), sp2 = Math.sin(2 * sp);
    const nr = b0 + b1 * cp + b2 * cp2, ni = b1 * sp + b2 * sp2;
    const dr = a0 + a1 * cp + a2 * cp2, di = a1 * sp + a2 * sp2;
    return 20 * Math.log10(Math.sqrt((nr ** 2 + ni ** 2) / (dr ** 2 + di ** 2)));
};

// INTERNAL PANEL COMPONENT (Unmounts completely)
const EqualizerPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [bands, setBands] = useState<Band[]>(() => (player.getEQBands() as Band[]) || DEFAULT_BANDS);
    const [presets, setPresets] = useState<Preset[]>(() => JSON.parse(localStorage.getItem('ytm-eq-presets') || '[{"name":"Flat","bands":[]}]'));
    const [activePreset, setActivePreset] = useState(() => localStorage.getItem('ytm-eq-active') || 'Flat');
    const [selectedBand, setSelectedBand] = useState<number | null>(null);
    const [showPresets, setShowPresets] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const analyzerRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>(0);

    const drawAnalyzer = useCallback(() => {
        if (!analyzerRef.current) return;
        const ctx = analyzerRef.current.getContext('2d', { alpha: false });
        if (!ctx) return;

        const data = player.getAnalyzerData();
        const { width, height } = analyzerRef.current;
        ctx.fillStyle = '#11111b'; ctx.fillRect(0, 0, width, height);
        
        if (data.length > 0 && player.isPlaying) {
            ctx.fillStyle = 'rgba(137, 180, 250, 0.2)';
            const barCount = 60, barWidth = width / barCount;
            for (let i = 0; i < barCount; i++) {
                const fS = getFreq(i * barWidth, width), fE = getFreq((i + 1) * barWidth, width);
                const iS = Math.max(0, Math.floor(fS / 22050 * data.length)), iE = Math.min(data.length - 1, Math.floor(fE / 22050 * data.length));
                let maxVal = 0;
                for (let j = iS; j <= iE; j++) if (data[j] > maxVal) maxVal = data[j];
                const barHeight = Math.min(height, (maxVal / 255) * height * (1 + (i / barCount) * 0.5));
                ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1, barHeight);
            }
        }
        requestRef.current = requestAnimationFrame(drawAnalyzer);
    }, []);

    useEffect(() => {
        requestRef.current = requestAnimationFrame(drawAnalyzer);
        return () => cancelAnimationFrame(requestRef.current);
    }, [drawAnalyzer]);

    useEffect(() => {
        if (!canvasRef.current) return;
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;
        const { width, height } = canvasRef.current;
        ctx.clearRect(0, 0, width, height);
        ctx.font = '10px Inter'; ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;

        [15, 10, 5, 0, -5, -10, -15].forEach(g => {
            const y = getY(g, height); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
            if (g !== 0) ctx.fillText(`${g > 0 ? '+' : ''}${g}dB`, 4, y - 4);
        });
        [60, 250, 1000, 4000, 10000, 16000].forEach(f => {
            const x = getX(f, width); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
            ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 4, height - 4);
        });

        ctx.beginPath(); ctx.strokeStyle = '#89b4fa'; ctx.lineWidth = 2;
        for (let x = 0; x < width; x++) {
            const f = getFreq(x, width); let totalGain = 0;
            bands.forEach(b => { totalGain += getMagnitudeResponse(f, b); });
            const y = getY(totalGain, height);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        bands.forEach((b, i) => {
            const x = getX(b.frequency, width), y = getY(b.gain, height), active = selectedBand === i;
            ctx.fillStyle = active ? '#89b4fa' : '#ffffff'; ctx.beginPath(); ctx.arc(x, y, active ? 5 : 4, 0, Math.PI * 2); ctx.fill();
            if (active) { ctx.strokeStyle = 'rgba(137, 180, 250, 0.4)'; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke(); }
        });
    }, [bands, selectedBand]);

    const handleMouseDown = (e: React.MouseEvent) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const { width, height } = canvasRef.current!;
        let found = -1;
        bands.forEach((b, i) => { if (Math.sqrt((x - getX(b.frequency, width))**2 + (y - getY(b.gain, height))**2) < 15) found = i; });
        if (found !== -1) { setSelectedBand(found); setIsDragging(true); } else setSelectedBand(null);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging || selectedBand === null) return;
        const rect = canvasRef.current!.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left)), y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        const { width, height } = canvasRef.current!;
        let nF = getFreq(x, width), nG = getGainFromY(y, height);
        const p = bands[selectedBand - 1], n = bands[selectedBand + 1];
        if (p && nF < p.frequency + 10) nF = p.frequency + 10; if (n && nF > n.frequency - 10) nF = n.frequency - 10;
        const newBands = [...bands]; newBands[selectedBand] = { ...newBands[selectedBand], frequency: nF, gain: nG };
        setBands(newBands); player.setBand(selectedBand, nG, nF); setActivePreset('Custom');
    };

    const applyPreset = (p: Preset) => {
        const b = p.bands.slice(0, 6); setBands(b); setActivePreset(p.name);
        b.forEach((band, i) => player.setBand(i, band.gain, band.frequency, band.type));
        localStorage.setItem('ytm-eq-active', p.name); setShowPresets(false);
    };

    const handleSave = () => {
        if (!newPresetName.trim()) return;
        const name = newPresetName.trim();
        const newPresets = [...presets.filter(p => p.name !== name), { name, bands: [...bands] }];
        setPresets(newPresets); setActivePreset(name);
        localStorage.setItem('ytm-eq-presets', JSON.stringify(newPresets));
        localStorage.setItem('ytm-eq-active', name); setIsSaving(false); setNewPresetName('');
    };

    const deletePreset = (name: string, e: React.MouseEvent) => {
        e.stopPropagation(); if (name === 'Flat') return;
        const newPresets = presets.filter(p => p.name !== name); setPresets(newPresets);
        if (activePreset === name) applyPreset(presets.find(p => p.name === 'Flat')!);
        localStorage.setItem('ytm-eq-presets', JSON.stringify(newPresets));
    };

    const updateType = (type: BiquadFilterType) => {
        if (selectedBand === null) return;
        const newBands = [...bands]; newBands[selectedBand] = { ...newBands[selectedBand], type };
        setBands(newBands); player.setBand(selectedBand, newBands[selectedBand].gain, newBands[selectedBand].frequency, type);
    };

    return (
        <div className={styles.menu}>
            <div className={styles.header}>
                {!isSaving ? (
                    <>
                        <div className={styles.presetSelector}>
                            <button className={styles.presetBtn} onClick={() => setShowPresets(!showPresets)}>{activePreset} <ChevronDown size={14} /></button>
                            {showPresets && (
                                <div className={styles.presetsDropdown}>
                                    {presets.map(p => (
                                        <div key={p.name} className={styles.presetItem} onClick={() => applyPreset(p)}>
                                            <span>{p.name}</span>
                                            <div className={styles.presetActions}>
                                                {activePreset === p.name && <Check size={12} />}
                                                {p.name !== 'Flat' && <Trash2 size={12} className={styles.deleteIcon} onClick={(e) => deletePreset(p.name, e)} />}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <IconButton icon={Plus} size={28} iconSize={14} onClick={() => setIsSaving(true)} title="Save current as new preset" />
                    </>
                ) : (
                    <div className={styles.saveForm}>
                        <input autoFocus placeholder="Preset Name..." value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} />
                        <IconButton icon={Check} size={28} onClick={handleSave} className={styles.saveBtn} />
                        <IconButton icon={CloseIcon} size={28} onClick={() => setIsSaving(false)} />
                    </div>
                )}
            </div>
            <div className={styles.visualizer}>
                <canvas ref={analyzerRef} width={288} height={140} className={styles.spectrum} />
                <canvas ref={canvasRef} width={288} height={140} className={styles.curve} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={() => setIsDragging(false)} onMouseLeave={() => setIsDragging(false)} />
            </div>
            <div className={styles.controls}>
                {selectedBand !== null ? (
                    <div className={styles.bandEditor}>
                        <div className={styles.info}><span>Band {selectedBand + 1}</span><span>{Math.round(bands[selectedBand].frequency)}Hz / {bands[selectedBand].gain.toFixed(1)}dB</span></div>
                        <div className={styles.typeGrid}>{FILTER_TYPES.map(t => (<button key={t} className={`${styles.typeBtn} ${bands[selectedBand].type === t ? styles.typeActive : ''}`} onClick={() => updateType(t)}>{t}</button>))}</div>
                    </div>
                ) : <p className={styles.hint}>Move points on the graph to adjust sound</p>}
            </div>
        </div>
    );
};

// MAIN WRAPPER (Static)
export const EqualizerMenu: React.FC = React.memo(() => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false); };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const toggleMenu = async () => {
        if (!isOpen) await player.initAudioContext();
        setIsOpen(!isOpen);
    };

    return (
        <div className={styles.container} ref={containerRef}>
            <IconButton icon={SlidersHorizontal} size={28} iconSize={14} onClick={toggleMenu} className={isOpen ? styles.active : ''} title="Equalizer" />
            {isOpen && <EqualizerPanel onClose={() => setIsOpen(false)} />}
        </div>
    );
});

EqualizerMenu.displayName = 'EqualizerMenu';
