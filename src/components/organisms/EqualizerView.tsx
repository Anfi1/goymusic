import React from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { useEqualizer } from '../../hooks/useEqualizer';
import { EqualizerPresets } from '../molecules/EqualizerPresets';
import styles from './EqualizerView.module.css';
import { DEFAULT_Q } from '../../utils/equalizer';
import { EqualizerCanvas } from '../molecules/EqualizerCanvas';

const FILTER_TYPES: BiquadFilterType[] = ['lowshelf', 'peaking', 'highshelf'];


// ── EqualizerView (full-screen page) ──

export const EqualizerView: React.FC<{ onBack: () => void }> = () => {
    const {
        state, bands, selectedBand, handleBandSelect, handleBandDrag, handleBandAdd, handleBandDelete,
        handleCurveAdjust, applyPreset, updateType, handleAddBand, handleReset,
    } = useEqualizer();

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Equalizer</h1>
                <div className={styles.spacer} />
                <EqualizerPresets state={state} onApply={applyPreset} />
            </div>

            <div className={styles.visualizer}>
                <EqualizerCanvas className={styles.canvas}
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
                            <span>{bands[selectedBand].gain.toFixed(1)}dB</span>
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
