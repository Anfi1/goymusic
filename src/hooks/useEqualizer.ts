import { useCallback, useState, useSyncExternalStore } from 'react';
import { player } from '../api/player';
import { FLAT_PRESET, type EqualizerPreset } from '../utils/equalizerPresets';

const subscribe = (onChange: () => void) => player.subscribe(onChange);
const handleBandDrag = (index: number, frequency: number, gain: number) => player.setBand(index, gain, frequency);
const handleBandAdd = (frequency: number, gain: number) => player.addBand(frequency, Math.round(gain * 2) / 2);
const handleAddBand = () => player.addBand(1000, 0);
const handleCurveAdjust = (index: number, Q: number) => {
    const band = player.getEQBands()[index];
    if (band) player.setBand(index, band.gain, undefined, undefined, Q);
};

export function useEqualizer() {
    const state = useSyncExternalStore(subscribe, player.getEQState);
    const [index, setIndex] = useState<number | null>(null);
    const selectedBand = index !== null && index < state.bands.length ? index : null;

    const handleBandDelete = useCallback((i: number) => {
        player.removeBand(i);
        setIndex(old => old === null || old === i ? null : old > i ? old - 1 : old);
    }, []);

    const applyPreset = (preset: EqualizerPreset) => {
        setIndex(null);
        player.applyEQPreset(preset);
    };
    const updateType = (type: BiquadFilterType) => {
        if (selectedBand !== null) player.setBand(selectedBand, state.bands[selectedBand].gain, undefined, type);
    };

    return {
        state, bands: state.bands, selectedBand, handleBandSelect: setIndex, handleBandDrag,
        handleBandAdd, handleBandDelete, handleCurveAdjust, updateType, handleAddBand,
        applyPreset, handleReset: () => applyPreset(FLAT_PRESET),
    };
}
