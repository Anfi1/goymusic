import React, { useState, useEffect, useRef } from 'react';
import { SlidersHorizontal, Plus, RotateCcw } from 'lucide-react';
import { useEqualizer } from '../../hooks/useEqualizer';
import { IconButton } from '../atoms/IconButton';
import styles from './EqualizerMenu.module.css';
import { DEFAULT_Q } from '../../utils/equalizer';
import { EqualizerCanvas } from './EqualizerCanvas';

import { EqualizerPresets } from './EqualizerPresets';

const FILTER_TYPES: BiquadFilterType[] = ['lowshelf', 'peaking', 'highshelf'];


// ── EqualizerPanel ───────────────────────────────────────────────────

const EqualizerPanel: React.FC = () => {
    const {
        state, bands, selectedBand, handleBandSelect, handleBandDrag, handleBandAdd, handleBandDelete,
        handleCurveAdjust, applyPreset, updateType, handleAddBand, handleReset,
    } = useEqualizer();
    const [cursorStyle, setCursorStyle] = useState<string>('crosshair');

    return (
        <div className={styles.menu}>
            {/* Header: preset selector + save */}
            <div className={styles.header}>
                <EqualizerPresets compact state={state} onApply={applyPreset} />
            </div>

            {/* Canvas visualizer */}
            <div className={styles.visualizer} style={{ cursor: cursorStyle }}>
                <EqualizerCanvas className={styles.canvas}
                    bands={bands}
                    selectedBand={selectedBand}
                    hoveredBandIndex={null}
                    onBandSelect={handleBandSelect}
                    onBandDrag={handleBandDrag}
                    onBandAdd={handleBandAdd}
                    onBandDelete={handleBandDelete}
                    onCurveAdjust={handleCurveAdjust}
                    onCursorChange={setCursorStyle}
                />
            </div>

            {/* Band editor */}
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
                                <button
                                    key={t}
                                    className={`${styles.typeBtn} ${bands[selectedBand].type === t ? styles.typeActive : ''}`}
                                    onClick={() => updateType(t)}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <p className={styles.hint}>Drag to move. Double-click to add a band. Scroll to adjust Q. Spectrum shown on background.</p>
                )}

                <div className={styles.bottomBar}>
                    <button className={styles.addBandBtn} onClick={handleAddBand}>
                        <Plus size={14} /> Add band
                    </button>
                    <button className={styles.resetBtn} onClick={handleReset}>
                        <RotateCcw size={14} /> Reset
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── EqualizerMenu wrapper ─────────────────────────────────────────────

export const EqualizerMenu: React.FC = React.memo(() => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div className={styles.container} ref={containerRef}>
            <IconButton
                icon={SlidersHorizontal}
                size={28}
                iconSize={14}
                onClick={() => setIsOpen(open => !open)}
                className={isOpen ? styles.active : ''}
                title="Equalizer"
            />
            {isOpen && <EqualizerPanel />}
        </div>
    );
});

EqualizerMenu.displayName = 'EqualizerMenu';
