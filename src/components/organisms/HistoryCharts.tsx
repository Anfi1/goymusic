import React, { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react';
import styles from './HistoryView.module.css';
import type { HydratedHistoryEntry } from '../../api/history';
import type { YTMTrack } from '../../api/yt';
import { getArtistDetail } from '../../api/yt';
import { player } from '../../api/player';
import { X, Clock, Users, Music2, Disc } from 'lucide-react';

const CHART_COLORS = [
  'rgba(96,165,250,0.95)',
  'rgba(16,185,129,0.95)',
  'rgba(249,115,22,0.95)',
  'rgba(236,72,153,0.95)',
  'rgba(14,165,233,0.95)',
  'rgba(168,85,247,0.95)',
  'rgba(34,197,94,0.95)',
  'rgba(245,158,11,0.95)',
];

interface ChartDataItem {
  key: string;
  title: string;
  subtitle: string;
  value: number;
  image?: string;
  type: 'artist' | 'track' | 'album';
  track?: YTMTrack;
  artistId?: string;
  albumId?: string;
}

function formatSeconds(s: number) {
  if (!s) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatTotalTime(total: number) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h >= 24) {
    const days = Math.floor(h / 24);
    const remainingHours = h % 24;
    if (remainingHours > 0) return `${days}d ${remainingHours}h`;
    return `${days}d`;
  }
  if (h > 0) {
    if (m > 0) return `${h}h ${m}m`;
    return `${h}h`;
  }
  if (m > 0) return `${m}m`;
  return `${Math.floor(total)}s`;
}

function makeShadowColor(color: string, alpha = 0.28) {
  const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleInDegrees: number
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: cx + r * Math.cos(angleInRadians),
    y: cy + r * Math.sin(angleInRadians),
  };
}

// Полный круг (angle >= 360) даёт вырожденную дугу (начало = конец) —
// ограничиваем развёртку чуть меньше полного оборота, чтобы SVG-дуга отрисовалась.
function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
) {
  const sweep = Math.min(endAngle - startAngle, 359.99);
  const clampedEnd = startAngle + sweep;
  const startOuter = polarToCartesian(cx, cy, rOuter, clampedEnd);
  const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
  const startInner = polarToCartesian(cx, cy, rInner, startAngle);
  const endInner = polarToCartesian(cx, cy, rInner, clampedEnd);
  const largeArc = sweep <= 180 ? '0' : '1';
  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${endInner.x} ${endInner.y}`,
    'Z',
  ].join(' ');
}

const PERIODS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'season', label: 'Season' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All' },
] as const;

const METRICS = [
  {
    value: 'artist' as const,
    label: 'Artists',
    icon: Users,
    description: 'Top artists you listened to',
  },
  {
    value: 'tracks' as const,
    label: 'Tracks',
    icon: Music2,
    description: 'Most played tracks',
  },
  {
    value: 'albums' as const,
    label: 'Albums',
    icon: Disc,
    description: 'Most listened albums',
  },
] as const;

const METRIC_CARD_META: Record<
  'artist' | 'tracks' | 'albums',
  { color: string; shadow: string }
> = {
  artist: { color: 'rgba(96,165,250,0.9)', shadow: 'rgba(96,165,250,0.18)' },
  tracks: { color: 'rgba(249,115,22,0.9)', shadow: 'rgba(249,115,22,0.18)' },
  albums: { color: 'rgba(168,85,247,0.9)', shadow: 'rgba(168,85,247,0.18)' },
};

const artistThumbsCache: Record<string, string> = {};

export default function HistoryCharts({
  rawHistory,
  onClose,
  onSelectArtist,
  onSelectAlbum,
  onPlayTrack,
}: {
  rawHistory: HydratedHistoryEntry[];
  onClose: () => void;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onPlayTrack?: (track: YTMTrack) => void;
}) {
  const [period, setPeriod] = useState('all');
  const [metric, setMetric] = useState<'artist' | 'tracks' | 'albums'>(
    'artist'
  );
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({ ...artistThumbsCache });
  const periodRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  const updateIndicator = useCallback(() => {
    const btn = periodRefs.current[PERIODS.findIndex(p => p.value === period)];
    const container = btn?.parentElement;
    if (btn && container) {
      setIndicatorStyle({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
      });
    }
  }, [period]);

  useEffect(() => {
    updateIndicator();
    window.addEventListener('resize', updateIndicator);
    return () => window.removeEventListener('resize', updateIndicator);
  }, [updateIndicator]);

  const startTime = useMemo(() => {
    const now = Date.now();
    if (period === 'week') return now - 7 * 24 * 3600 * 1000;
    if (period === 'month') return now - 30 * 24 * 3600 * 1000;
    if (period === 'season') return now - 90 * 24 * 3600 * 1000;
    if (period === 'year') return now - 365 * 24 * 3600 * 1000;
    return 0;
  }, [period]);

  const agg = useMemo(() => {
    const map = new Map<string, ChartDataItem>();
    rawHistory.forEach((h) => {
      if (h.timestamp < startTime) return;
      // Используем реальное время прослушивания; если 0 — трек был переключён быстро
      const seconds = h.listenedSeconds || 0;
      const cover = h.track.thumbUrl || (h.track as any).album?.thumbUrl || '';

      if (metric === 'artist') {
        const artistName =
          Array.isArray(h.track.artists) && h.track.artists.length
            ? h.track.artists[0]
            : 'Unknown';
        const artistId = h.track.artistIds?.[0] || artistName;
        const key = `artist:${artistId}`;
        const title = artistName;
        const subtitle = h.track.album || '';
        const existing = map.get(key);
        if (existing) {
          map.set(key, { ...existing, value: existing.value + seconds });
        } else {
          map.set(key, {
            key,
            title,
            subtitle,
            value: seconds,
            image: cover,
            type: 'artist',
            artistId,
            track: h.track,
          });
        }
      } else if (metric === 'albums') {
        const albumTitle = h.track.album || 'Unknown album';
        const albumArtist = h.track.artists?.[0] || 'Unknown';
        // Группируем по альбому + артист, чтобы не смешивать разных исполнителей
        const albumId = h.track.albumId || `${albumTitle} - ${albumArtist}`;
        const key = `album:${albumId}`;
        const title = albumTitle;
        const subtitle = h.track.artists?.join(', ') || '';
        const existing = map.get(key);
        if (existing) {
          map.set(key, { ...existing, value: existing.value + seconds });
        } else {
          map.set(key, {
            key,
            title,
            subtitle,
            value: seconds,
            image: cover,
            type: 'album',
            albumId,
            track: h.track,
          });
        }
      } else {
        const title = h.track.title || 'Unknown';
        const artists = h.track.artists?.join(', ') || '';
        const key = `track:${h.track.id}`;
        const subtitle = artists;
        const existing = map.get(key);
        if (existing) {
          map.set(key, { ...existing, value: existing.value + seconds });
        } else {
          map.set(key, {
            key,
            title,
            subtitle,
            value: seconds,
            image: cover,
            type: 'track',
            track: h.track,
          });
        }
      }
    });

    const arr = Array.from(map.values());
    // Фильтруем "Unknown album" для графиков альбомов
    const filteredArr = metric === 'albums' 
      ? arr.filter(item => item.title !== 'Unknown album' && item.title !== 'Unknown')
      : arr;
    filteredArr.sort((a, b) => b.value - a.value);
    const totalValue = filteredArr.reduce((sum, item) => sum + item.value, 0) || 1;
    const maxSlices = 12;
    const minPct = 0.05;
    const top: ChartDataItem[] = [];
    let usedValue = 0;

    for (const item of filteredArr) {
      const pct = item.value / totalValue;
      if (top.length < maxSlices && (top.length < 8 || pct >= minPct)) {
        top.push(item);
        usedValue += item.value;
      } else {
        break;
      }
    }

    const other = totalValue - usedValue;
    if (other > 0) {
      const hiddenCount = filteredArr.length - top.length;
      const itemLabel =
        metric === 'artist'
          ? 'artists'
          : metric === 'albums'
            ? 'albums'
            : 'tracks';
      top.push({
        key: 'other',
        title: 'Other',
        subtitle: `${hiddenCount} more ${itemLabel}`,
        value: other,
        type:
          metric === 'tracks'
            ? 'track'
            : metric === 'albums'
              ? 'album'
              : 'artist',
      });
    }
    return top;
  }, [rawHistory, startTime, metric]);

  const total = useMemo(
    () => agg.reduce((s, a) => s + a.value, 0) || 1,
    [agg]
  );
  const totalTracks = useMemo(() => {
    const filtered = rawHistory.filter((h) => h.timestamp >= startTime);
    if (metric === 'albums') {
      return filtered.filter((h) => h.track.album && h.track.album !== 'Unknown album').length;
    }
    return filtered.length;
  }, [rawHistory, startTime, metric]);
  const [playerState, setPlayerState] = useState({
    currentTrackId: player.currentTrack?.id,
    currentArtistIds: player.currentTrack?.artistIds || [] as string[],
    currentAlbumId: player.currentTrack?.albumId,
    isPlaying: player.isPlaying,
  });

  useEffect(() => {
    return player.subscribe(() => {
      setPlayerState({
        currentTrackId: player.currentTrack?.id,
        currentArtistIds: player.currentTrack?.artistIds || [],
        currentAlbumId: player.currentTrack?.albumId,
        isPlaying: player.isPlaying,
      });
    });
  }, []);

  const { currentTrackId, currentArtistIds, currentAlbumId, isPlaying } = playerState;

  const handleLegendClick = (item: ChartDataItem) => {
    if (item.key === 'other') return;
    if (metric === 'artist' && item.artistId) {
      onSelectArtist?.(item.artistId);
      return;
    }
    if (metric === 'albums' && item.albumId) {
      onSelectAlbum?.(item.albumId);
      return;
    }
    if ((metric === 'tracks' || metric === 'albums') && item.track) {
      onPlayTrack?.(item.track);
    }
  };

  useEffect(() => {
    if (metric !== 'artist' || agg.length === 0) return;

    const artistIds = Array.from(
      new Set(
        agg
          .filter((item) => item.type === 'artist' && item.key !== 'other')
          .map((item) => item.key.replace(/^artist:/, ''))
          .filter((id) => id && id !== 'Unknown')
      )
    );

    if (!artistIds.length) return;

    let active = true;
    Promise.all(
      artistIds.map(async (artistId) => {
        try {
          const detail = await getArtistDetail(artistId);
          return { artistId, thumbUrl: detail?.thumbUrl || '' };
        } catch {
          return { artistId, thumbUrl: '' };
        }
      })
    ).then((results) => {
      if (!active) return;
      const next: Record<string, string> = {};
      results.forEach(({ artistId, thumbUrl }) => {
        if (thumbUrl) next[`artist:${artistId}`] = thumbUrl;
      });
      if (Object.keys(next).length) {
        Object.assign(artistThumbsCache, next);
        setArtistThumbs((prev) => ({ ...prev, ...next }));
      }
    });

    return () => {
      active = false;
    };
  }, [agg, metric]);

  const currentMetric = METRICS.find((m) => m.value === metric)!;
  const activePeriodIndex = PERIODS.findIndex((p) => p.value === period);
  const chartKey = `${metric}-${period}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e as any).keyCode === 27) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={styles.chartsOverlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Listening Charts"
    >
      <div className={styles.chartsModal} onClick={(e) => e.stopPropagation()}>
        {/* Header with period picker */}
        <div className={styles.chartsHeader}>
          <div className={styles.chartsHeaderLeft}>
            <h3>Listening Charts</h3>
            <div className={styles.periodPicker}>
              <div
                className={styles.periodIndicator}
                style={{
                  left: `${indicatorStyle.left}px`,
                  width: `${indicatorStyle.width}px`,
                }}
              />
              {PERIODS.map((p, pi) => (
                <button
                  key={p.value}
                  ref={el => { periodRefs.current[pi] = el; }}
                  className={`${styles.periodBtn} ${period === p.value ? styles.periodBtnActive : ''}`}
                  onClick={() => setPeriod(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <button
            className={styles.btnClose}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Metric selector — visual cards */}
        <div className={styles.metricSelector}>
          {METRICS.map((m) => {
            const Icon = m.icon;
            const isActive = metric === m.value;
            const meta = METRIC_CARD_META[m.value];
            return (
              <button
                key={m.value}
                className={`${styles.metricCard} ${isActive ? styles.metricCardActive : ''}`}
                onClick={() => setMetric(m.value)}
                style={
                  {
                    '--metric-color': meta.color,
                    '--metric-shadow': meta.shadow,
                  } as React.CSSProperties
                }
              >
                <div className={styles.metricIcon}>
                  <Icon size={20} />
                </div>
                <div className={styles.metricInfo}>
                  <div className={styles.metricLabel}>{m.label}</div>
                  <div className={styles.metricDesc}>{m.description}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className={styles.chartsContent}>
          {/* Chart */}
          <div className={styles.chartContainer} key={chartKey}>
            <svg
              width={320}
              height={320}
              viewBox="0 0 320 320"
              className={styles.chartSvg}
            >
              <defs>
                <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="rgba(0,0,0,0.8)" />
                </filter>
              </defs>
              {/* Outer ring */}
              <circle
                cx={160}
                cy={160}
                r={150}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.04}
                strokeWidth={1}
              />

              {/* Donut */}
              {(() => {
                const cx = 160,
                  cy = 160,
                  rOuter = 138,
                  rInner = 92;
                const gapDeg = 3;
                let start = 0;
                return agg.map((slice, i) => {
                  const rawAngle = (slice.value / total) * 360;
                  if (rawAngle < 0.5) return null;
                  const sweep = Math.max(rawAngle - gapDeg, 0.5);
                  const segStart = start + gapDeg / 2;
                  const segEnd = segStart + sweep;
                  const path = donutSlicePath(cx, cy, rOuter, rInner, segStart, segEnd);
                  const color = CHART_COLORS[i % CHART_COLORS.length];
                  const isHighlighted = hoveredIndex === i;
                  const midAngle = start + rawAngle / 2;
                  const rMid = (rOuter + rInner) / 2;
                  const chartRotation = -60;
                  const rotatedLabelPoint = polarToCartesian(
                    cx,
                    cy,
                    rMid,
                    midAngle + chartRotation
                  );
                  const pct = Math.round((slice.value / total) * 100);
                  const showLabel = pct >= 5;
                  const tooltipText = `${slice.title} - ${pct}% ${formatSeconds(
                    slice.value
                  )}`;
                  const sliceFill =
                    slice.key === 'other' ? 'rgba(145, 155, 190, 0.32)' : color;
                  const fillOpacity =
                    slice.key === 'other'
                      ? isHighlighted
                        ? 0.5
                        : 0.25
                      : hoveredIndex === null
                        ? 1
                        : isHighlighted
                          ? 1
                          : 0.88;
                  const pathShadow = isHighlighted
                    ? `drop-shadow(0 3px 10px ${makeShadowColor(color, 0.12)})`
                    : `drop-shadow(0 1px 4px ${makeShadowColor(color, 0.04)})`;

                  const popDist = isHighlighted ? 8 : 0;
                  const baseRad = ((midAngle - 90) * Math.PI) / 180;
                  const segPopDx = popDist * Math.cos(baseRad);
                  const segPopDy = popDist * Math.sin(baseRad);
                  const screenAngle = midAngle + chartRotation;
                  const txtRad = ((screenAngle - 90) * Math.PI) / 180;
                  const txtPopDx = popDist * Math.cos(txtRad);
                  const txtPopDy = popDist * Math.sin(txtRad);

                  start += rawAngle;
                  return (
                    <g key={slice.key}>
                      <g
                        transform={`rotate(${chartRotation} ${cx} ${cy})`}
                        onMouseEnter={() => setHoveredIndex(i)}
                        onMouseLeave={() => setHoveredIndex(null)}
                        onClick={() => handleLegendClick(slice)}
                        style={{ cursor: slice.key === 'other' ? 'default' : 'pointer' }}
                      >
                        {/* Invisible trigger — stays in place */}
                        <path
                          d={path}
                          fill="transparent"
                          stroke="none"
                        />
                        {/* Visible segment — pops out */}
                        <g
                          style={{
                            transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                            transform: `translate(${segPopDx}px, ${segPopDy}px)`,
                          }}
                        >
                          <path
                            d={path}
                            fill={sliceFill}
                            fillOpacity={fillOpacity}
                            stroke="none"
                            style={{
                              transition: 'fill-opacity 0.2s ease',
                              filter: pathShadow,
                              pointerEvents: 'none',
                            }}
                          >
                            <title>{tooltipText}</title>
                          </path>
                        </g>
                      </g>
                      {/* Label — also pops out */}
                      {showLabel && (
                        <g
                          style={{
                            transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                            transform: `translate(${txtPopDx}px, ${txtPopDy}px)`,
                          }}
                        >
                          <text
                            x={rotatedLabelPoint.x}
                            y={rotatedLabelPoint.y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill="rgba(255,255,255,0.92)"
                            fontSize="12"
                            fontWeight={700}
                            pointerEvents="none"
                            filter="url(#textShadow)"
                          >
                            {pct}%
                          </text>
                        </g>
                      )}
                    </g>
                  );
                });
              })()}

              {/* Center */}
              <circle cx={160} cy={160} r={86} fill="rgba(15,15,25,0.95)" />
              <circle
                cx={160}
                cy={160}
                r={86}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.08}
                strokeWidth={1}
              />
              <text
                x={160}
                y={155}
                textAnchor="middle"
                fill="var(--text-main)"
                fontSize={18}
                fontWeight={700}
              >
                {formatTotalTime(total)}
              </text>
              <text
                x={160}
                y={172}
                textAnchor="middle"
                fill="var(--text-sub)"
                fontSize={11}
                opacity={0.6}
              >
                {totalTracks} tracks
              </text>
            </svg>
          </div>

          {/* Legend */}
          <div className={styles.chartLegend}>
            {agg.map((s, i) => {
              const image = s.image;
              const title = s.title;
              const subtitle = s.subtitle;
              const pct = Math.round((s.value / total) * 100);
              const color = CHART_COLORS[i % CHART_COLORS.length];
              const isHighlighted = hoveredIndex === i;
              const statusText =
                metric === 'tracks' &&
                s.track?.id === currentTrackId &&
                isPlaying
                  ? 'Now playing'
                  : metric === 'tracks' && s.track?.id === currentTrackId
                    ? 'Current'
                    : metric === 'albums' &&
                        s.albumId &&
                        s.albumId === currentAlbumId
                      ? 'Current'
                      : undefined;
              return (
                <button
                  key={s.key}
                  className={`${styles.legendItem} ${isHighlighted ? styles.legendItemHover : ''}`}
                  type="button"
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onClick={() => handleLegendClick(s)}
                  style={
                    {
                      '--legend-shadow': `0 6px 12px ${makeShadowColor(color, 0.06)}`,
                      '--legend-hover-shadow': `0 8px 18px ${makeShadowColor(color, 0.08)}`,
                    } as React.CSSProperties
                  }
                >
                  <div
                    className={styles.legendColor}
                    style={{ background: color }}
                  />
                  {metric === 'artist' && (artistThumbs[s.key] || image) ? (
                    <img
                      src={artistThumbs[s.key] || image}
                      alt={title}
                      className={styles.legendImage}
                      loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : image ? (
                    <img
                      src={image}
                      alt={title}
                      className={styles.legendImage}
                      loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className={styles.legendImagePlaceholder}>
                      <Music2 size={16} />
                    </div>
                  )}
                  <div className={styles.legendText}>
                    <div className={styles.legendTitle} data-tooltip={title} data-tooltip-overflow="">{title}</div>
                    {subtitle && (
                      <div className={styles.legendSubtitle} data-tooltip={subtitle} data-tooltip-overflow="">{subtitle}</div>
                    )}
                    <div className={styles.legendMeta}>
                      <Clock size={10} className={styles.legendClock} />
                      {formatSeconds(s.value)} · {pct}%
                      {statusText && (
                        <span className={styles.legendStatus}>
                          · {statusText}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={styles.legendValue}>{pct}%</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
