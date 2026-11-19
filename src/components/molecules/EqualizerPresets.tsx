import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { player } from '../../api/player';
import { BUILTIN_PRESETS, type EqualizerPreset, type EqualizerState } from '../../utils/equalizerPresets';
import { IconButton } from '../atoms/IconButton';
import styles from './EqualizerPresets.module.css';

interface Props {
    state: EqualizerState;
    onApply: (preset: EqualizerPreset) => void;
    compact?: boolean;
}

export function EqualizerPresets({ state, onApply, compact }: Props) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const { activeId, saved } = state;
    const active = BUILTIN_PRESETS.find(p => p.id === activeId) ?? saved.find(p => p.id === activeId);
    const duplicate = saved.some(p => p.name === name.trim());
    const size = compact ? 28 : 36;

    useEffect(() => {
        if (!open) return;
        const dismiss = (e: PointerEvent) => {
            if (!root.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [open]);

    const finishSave = () => {
        if (player.saveEQPreset(name)) { setName(''); setSaving(false); }
    };
    const rows = (presets: EqualizerPreset[], isSaved: boolean) => presets.map(preset => (
        <div className={styles.row} key={preset.id}>
            <button className={styles.option} type="button" aria-pressed={activeId === preset.id}
                onClick={() => { onApply(preset); setOpen(false); trigger.current?.focus(); }}>
                <span>{preset.name}</span>{activeId === preset.id && <Check size={14} />}
            </button>
            {isSaved && <IconButton icon={Trash2} size={28} iconSize={14} title={`Delete ${preset.name}`}
                onClick={() => player.deleteEQPreset(preset.id)} />}
        </div>
    ));

    return (
        <div ref={root} className={`${styles.controls} ${compact ? styles.compact : ''}`}
            onKeyDown={e => {
                if (e.key === 'Escape' && (open || saving)) {
                    e.stopPropagation(); setOpen(false); setSaving(false); trigger.current?.focus();
                }
            }}>
            {saving ? <>
                <input autoFocus aria-label="Preset name" aria-invalid={duplicate} placeholder="Preset name…" value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishSave(); } }} />
                {duplicate && <small role="status">Name already in use</small>}
                <IconButton icon={Check} size={size} disabled={!name.trim() || duplicate} title="Save preset" onClick={finishSave} />
                <IconButton icon={X} size={size} title="Cancel" onClick={() => setSaving(false)} />
            </> : <>
                <div className={styles.selector}>
                    <button ref={trigger} className={styles.trigger} type="button" aria-expanded={open}
                        onClick={() => setOpen(!open)}>{active?.name ?? 'Custom'} <ChevronDown size={14} /></button>
                    {open && <div className={styles.dropdown}>
                        <div role="group" aria-label="Built-in presets"><div className={styles.label}>Built-in</div>{rows(BUILTIN_PRESETS, false)}</div>
                        {saved.length > 0 && <div role="group" aria-label="Saved presets"><div className={styles.label}>Saved</div>{rows(saved, true)}</div>}
                    </div>}
                </div>
                <IconButton icon={Plus} size={size} iconSize={compact ? 14 : 18} title="Save preset" onClick={() => { setOpen(false); setSaving(true); }} />
            </>}
        </div>
    );
}
