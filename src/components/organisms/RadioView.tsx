import React, { useState, useCallback, useEffect, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, ChevronDown, ChevronUp, Radio, LayoutGrid, Sparkles, Volume2 } from 'lucide-react';
import { getMixedForYou, getPlaylistTracks, YTMMix } from '../../api/yt';
import { player } from '../../api/player';
import { LazyImage } from '../atoms/LazyImage';
import { Skeleton } from '../atoms/Skeleton';
import styles from './RadioView.module.css';

// ─── Grouping ────────────────────────────────────────────────────────────────

function groupKey(title: string): string {
    return title.trim()
        .replace(/\s+\d+$/, '')
        .replace(/Супермикс/g, 'Микс')
        .replace(/супермикс/g, 'микс')
        .replace(/\s+/g, ' ')
        .trim();
}

function groupMixes(mixes: YTMMix[]): Map<string, YTMMix[]> {
    const map = new Map<string, YTMMix[]>();
    for (const mix of mixes) {
        const key = groupKey(mix.title);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(mix);
    }
    return map;
}

// ─── Mood categories ─────────────────────────────────────────────────────────

interface MoodCategory {
    id: string;
    label: string;
    emoji: string;
    keywords: string[];
    color: string;
}

const MOOD_CATEGORIES: MoodCategory[] = [
    { id: 'personal',  label: 'Мой микс',          emoji: '🎵', keywords: ['мой микс', 'my mix'],                                  color: '#89b4fa' },
    { id: 'happy',     label: 'Хорошее настроение', emoji: '😊', keywords: ['хорошего настроен', 'good mood'],                      color: '#a6e3a1' },
    { id: 'sad',       label: 'Грустное',            emoji: '🌧', keywords: ['грустн', 'sad'],                                       color: '#89dceb' },
    { id: 'sleep',     label: 'Сон',                 emoji: '🌙', keywords: ['для сна', 'sleep'],                                    color: '#b4befe' },
    { id: 'chill',     label: 'Отдых',               emoji: '🌊', keywords: ['отдых', 'chill', 'романтич', 'romantic'],              color: '#94e2d5' },
    { id: 'energy',    label: 'Энергия',             emoji: '⚡', keywords: ['фитнес', 'бодрост', 'fitness', 'energy'],             color: '#f9e2af' },
    { id: 'party',     label: 'Вечеринка',           emoji: '🎉', keywords: ['вечеринк', 'party', 'коачелл'],                       color: '#f38ba8' },
    { id: 'focus',     label: 'Концентрация',        emoji: '🎯', keywords: ['концентрац', 'focus'],                                 color: '#fab387' },
    { id: 'throwback', label: 'Ностальгия',          emoji: '📼', keywords: ['архивн', 'риплей', 'replay', 'archiv'],               color: '#cba6f7' },
    { id: 'discovery', label: 'Открытия',            emoji: '✨', keywords: ['рекоменд', 'новых релизов', 'new release', 'discover'], color: '#f5c2e7' },
];

function assignCategory(groupName: string): MoodCategory | null {
    const lower = groupName.toLowerCase();
    for (const cat of MOOD_CATEGORIES) {
        if (cat.keywords.some(kw => lower.includes(kw))) return cat;
    }
    return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function playMix(mix: YTMMix) {
    const { tracks } = await getPlaylistTracks(mix.playlistId);
    if (tracks.length > 0) player.playTrackList(tracks, 0, mix.playlistId);
}

function useActivePlaylistId() {
    const [activeId, setActiveId] = useState<string | null>(player.queueSourceId);
    useEffect(() => {
        return player.subscribe((event) => {
            if (event === 'state') setActiveId(player.queueSourceId);
        });
    }, []);
    return activeId;
}

function usePlayerIsPlaying() {
    const [playing, setPlaying] = useState(player.isPlaying);
    useEffect(() => {
        return player.subscribe((event) => {
            if (event !== 'tick') setPlaying(player.isPlaying);
        });
    }, []);
    return playing;
}

// ─── Detailed mode: GroupCard ─────────────────────────────────────────────────

interface GroupCardProps { groupName: string; mixes: YTMMix[]; activePlaylistId: string | null }

const GroupCard: React.FC<GroupCardProps> = ({ groupName, mixes, activePlaylistId }) => {
    const [expanded, setExpanded] = useState(false);
    const [loading, setLoading] = useState(false);
    const supermix = mixes.find(m => /супер|super/i.test(m.title)) ?? mixes[0];
    const isActive = mixes.some(m => m.playlistId === activePlaylistId);

    const handleCardClick = useCallback(async () => {
        if (mixes.length === 1) { setLoading(true); await playMix(mixes[0]); setLoading(false); }
        else setExpanded(p => !p);
    }, [mixes]);

    const handlePlayMix = useCallback(async (e: React.MouseEvent, mix: YTMMix) => {
        e.stopPropagation(); setLoading(true); await playMix(mix); setLoading(false);
    }, []);

    return (
        <div className={`${styles.groupCard} ${isActive ? styles.groupCardActive : ''}`}>
            <div className={styles.cardMain} onClick={handleCardClick}>
                <div className={styles.thumbWrap}>
                    <LazyImage src={supermix.thumbUrl} alt={groupName} className={styles.thumb} />
                    {loading ? (
                        <div className={`${styles.thumbOverlay} ${styles.thumbOverlayVisible}`}><div className={styles.spinner} /></div>
                    ) : (
                        <div className={styles.thumbOverlay}>
                            {mixes.length === 1 ? <Play className={styles.playIcon} size={24} fill="currentColor" />
                                : expanded ? <ChevronUp className={styles.playIcon} size={24} />
                                : <ChevronDown className={styles.playIcon} size={24} />}
                        </div>
                    )}
                    {isActive && <div className={styles.activeIndicator}><Volume2 size={12} /></div>}
                </div>
                <div className={styles.cardInfo}>
                    <span className={styles.cardTitle}>{groupName}</span>
                    <span className={styles.cardSub}>{mixes.length > 1 ? `${mixes.length} варианта` : supermix.title}</span>
                </div>
            </div>
            {expanded && mixes.length > 1 && (
                <div className={styles.subList}>
                    {mixes.map(mix => (
                        <div key={mix.playlistId} className={`${styles.subItem} ${mix.playlistId === activePlaylistId ? styles.subItemActive : ''}`} onClick={e => handlePlayMix(e, mix)}>
                            {mix.playlistId === activePlaylistId ? <Volume2 size={13} className={styles.subPlayIcon} /> : <Play size={13} fill="currentColor" className={styles.subPlayIcon} />}
                            <span className={styles.subTitle}>{mix.title}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ─── Simple mode — isolated sub-components ───────────────────────────────────

// Re-renders only when play/pause changes, isolated from the rest of SimpleMode
const MixPlayingOverlay: React.FC = () => {
    const playing = usePlayerIsPlaying();
    if (!playing) return null;
    return (
        <div className={styles.mixPlayingOverlay}>
            <div className={styles.mixBars}>
                <span className={styles.mixBar} />
                <span className={styles.mixBar} />
                <span className={styles.mixBar} />
            </div>
        </div>
    );
};

interface MixRowProps {
    mix: YTMMix;
    isActive: boolean;
    isSuper: boolean;
    isLoading: boolean;
    onPlay: (mix: YTMMix) => void;
}

const MixRow: React.FC<MixRowProps> = memo(({ mix, isActive, isSuper, isLoading, onPlay }) => (
    <div
        className={`${styles.mixRow} ${isActive ? styles.mixRowActive : ''} ${isSuper ? styles.mixRowSuper : ''}`}
        data-tooltip={mix.title}
        data-tooltip-overflow=""
        onClick={() => !isLoading && onPlay(mix)}
    >
        <div className={`${styles.mixThumb} ${isSuper ? styles.mixThumbSuper : ''}`}>
            <LazyImage src={mix.thumbUrl} alt={mix.title} className={styles.mixThumbImg} />
            {isSuper && <span className={styles.mixSuperStar}>★</span>}
            {isActive && <MixPlayingOverlay />}
        </div>
        <div className={styles.mixInfo}>
            <span className={styles.mixTitle}>{mix.title}</span>
        </div>
        <div className={styles.mixAction}>
            {isLoading ? (
                <div className={styles.spinner} />
            ) : (
                <Play size={16} fill="currentColor" className={styles.mixPlayIcon} />
            )}
        </div>
    </div>
));

// ─── Simple mode ──────────────────────────────────────────────────────────────

interface SimpleModeProps {
    moodGroups: { category: MoodCategory; mixes: YTMMix[] }[];
    activePlaylistId: string | null;
}

const SimpleMode: React.FC<SimpleModeProps> = ({ moodGroups, activePlaylistId }) => {
    const [selectedCat, setSelectedCat] = useState<string>(() => {
        if (activePlaylistId) {
            for (const { category, mixes } of moodGroups) {
                if (mixes.some(m => m.playlistId === activePlaylistId)) return category.id;
            }
        }
        return moodGroups[0]?.category.id ?? '';
    });
    const [loading, setLoading] = useState<string | null>(null);

    const currentGroup = moodGroups.find(g => g.category.id === selectedCat);

    const handlePlay = useCallback(async (mix: YTMMix) => {
        setLoading(mix.playlistId);
        await playMix(mix);
        setLoading(null);
    }, []);

    // Sort: supermix first
    const sortedMixes = currentGroup
        ? [...currentGroup.mixes].sort((a, b) => {
            const aSuper = /супер|super/i.test(a.title) ? -1 : 1;
            const bSuper = /супер|super/i.test(b.title) ? -1 : 1;
            return aSuper - bSuper;
        })
        : [];

    return (
        <div className={styles.simpleLayout}>
            {/* Genre pills — right sidebar */}
            <div className={styles.genreList}>
                {moodGroups.map(({ category, mixes: m }) => {
                    const isPlaying = m.some(mx => mx.playlistId === activePlaylistId);
                    return (
                        <button
                            key={category.id}
                            className={`${styles.genrePill} ${selectedCat === category.id ? styles.genrePillActive : ''}`}
                            style={{ '--mood-color': category.color } as React.CSSProperties}
                            onClick={() => setSelectedCat(category.id)}
                        >
                            <span className={styles.genreEmoji}>{category.emoji}</span>
                            <span className={styles.genreLabel}>{category.label}</span>
                            {isPlaying && <span className={styles.genrePlaying}><Volume2 size={11} /></span>}
                        </button>
                    );
                })}
            </div>

            {/* Mix grid — center */}
            <div className={styles.mixGrid}>
                {sortedMixes.map(mix => (
                    <MixRow
                        key={mix.playlistId}
                        mix={mix}
                        isActive={mix.playlistId === activePlaylistId}
                        isSuper={/супер|super/i.test(mix.title)}
                        isLoading={loading === mix.playlistId}
                        onPlay={handlePlay}
                    />
                ))}
            </div>
        </div>
    );
};

// ─── Skeletons ────────────────────────────────────────────────────────────────

const GroupCardSkeleton: React.FC = () => (
    <div className={styles.groupCard} style={{ cursor: 'default' }}>
        <Skeleton width="100%" style={{ aspectRatio: '1 / 1' }} borderRadius={0} />
        <div className={styles.cardInfo}>
            <Skeleton width="75%" height={13} borderRadius={4} />
            <div style={{ marginTop: 5 }}><Skeleton width="45%" height={11} borderRadius={4} /></div>
        </div>
    </div>
);

const SimpleSkeleton: React.FC = () => (
    <div className={styles.simpleLayout}>
        <div className={styles.genreList}>
            {MOOD_CATEGORIES.map((cat) => (
                <button
                    key={cat.id}
                    className={styles.genrePill}
                    style={{ '--mood-color': cat.color, opacity: 0.45, cursor: 'default', pointerEvents: 'none' } as React.CSSProperties}
                    disabled
                >
                    <span className={styles.genreEmoji}>{cat.emoji}</span>
                    <span className={styles.genreLabel}>{cat.label}</span>
                </button>
            ))}
        </div>
        <div className={styles.mixGrid}>
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={styles.mixRow} style={{ cursor: 'default' }}>
                    <Skeleton width={56} height={56} borderRadius={8} />
                    <div style={{ flex: 1, marginLeft: 10 }}><Skeleton width="65%" height={13} borderRadius={4} /></div>
                </div>
            ))}
        </div>
    </div>
);

// ─── Main view ────────────────────────────────────────────────────────────────

type DisplayMode = 'simple' | 'detailed';

function loadMode(): DisplayMode {
    return (localStorage.getItem('radio-display-mode') as DisplayMode) ?? 'simple';
}

export const RadioView: React.FC = () => {
    const [mode, setMode] = useState<DisplayMode>(loadMode);
    const activePlaylistId = useActivePlaylistId();

    const { data: mixes, isLoading, isError } = useQuery({
        queryKey: ['mixed_for_you'],
        queryFn: getMixedForYou,
        staleTime: 1000 * 60 * 30,
    });

    const groups = mixes ? groupMixes(mixes) : null;

    const moodGroups = groups
        ? (() => {
            const result: { category: MoodCategory; mixes: YTMMix[] }[] = [];
            for (const cat of MOOD_CATEGORIES) {
                const catMixes: YTMMix[] = [];
                for (const [name, members] of groups.entries()) {
                    if (assignCategory(name)?.id === cat.id) catMixes.push(...members);
                }
                if (catMixes.length > 0) result.push({ category: cat, mixes: catMixes });
            }
            return result;
        })()
        : null;

    const toggleMode = useCallback(() => {
        setMode(prev => {
            const next: DisplayMode = prev === 'simple' ? 'detailed' : 'simple';
            localStorage.setItem('radio-display-mode', next);
            return next;
        });
    }, []);

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerIcon}><Radio size={28} /></div>
                <div style={{ flex: 1 }}>
                    <h2 className={styles.heading}>Миксы</h2>
                    <p className={styles.subheading}>Персональные подборки на основе твоего вкуса</p>
                </div>
                <button className={styles.modeToggle} onClick={toggleMode} data-tooltip={mode === 'simple' ? 'Подробный вид' : 'Простой вид'}>
                    {mode === 'simple' ? <LayoutGrid size={16} /> : <Sparkles size={16} />}
                    <span>{mode === 'simple' ? 'Подробнее' : 'Просто'}</span>
                </button>
            </div>

            {isLoading && (mode === 'simple' ? <SimpleSkeleton /> : (
                <div className={styles.grid}>
                    {Array.from({ length: 12 }).map((_, i) => <GroupCardSkeleton key={i} />)}
                </div>
            ))}
            {isError && <p className={styles.error}>Failed to load mixes.</p>}

            {mode === 'simple' && moodGroups && (
                <SimpleMode moodGroups={moodGroups} activePlaylistId={activePlaylistId} />
            )}

            {mode === 'detailed' && groups && (
                <div className={styles.grid}>
                    {Array.from(groups.entries()).map(([name, members]) => (
                        <GroupCard key={name} groupName={name} mixes={members} activePlaylistId={activePlaylistId} />
                    ))}
                </div>
            )}
        </div>
    );
};
