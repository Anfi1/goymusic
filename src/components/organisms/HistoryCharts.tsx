import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import styles from './HistoryView.module.css';
import type { HistoryEntry } from '../../api/history';
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

export default function HistoryCharts({
  rawHistory,
  onClose,
  onSelectArtist,
  onSelectAlbum,
  onPlayTrack,
}: {
  rawHistory: HistoryEntry[];
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
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});

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
      const hiddenCount = arr.length - top.length;
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
  const totalTracks = useMemo(
    () => rawHistory.filter((h) => h.timestamp >= startTime).length,
    [rawHistory, startTime]
  );
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
      if (Object.keys(next).length)
        setArtistThumbs((prev) => ({ ...prev, ...next }));
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
        {/* Header */}
        <div className={styles.chartsHeader}>
          <div>
            <h3>Listening Charts</h3>
          </div>
          <button
            className={styles.btnClose}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Period picker — pill style */}
        <div className={styles.periodPicker}>
          <div
            className={styles.periodIndicator}
            style={{
              left: `${activePeriodIndex * (100 / PERIODS.length)}%`,
              width: `calc(100% / ${PERIODS.length})`,
            }}
          />
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`${styles.periodBtn} ${period === p.value ? styles.periodBtnActive : ''}`}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
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
              width={260}
              height={260}
              viewBox="0 0 260 260"
              className={styles.chartSvg}
            >
              {/* Outer ring */}
              <circle
                cx={130}
                cy={130}
                r={115}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.04}
                strokeWidth={1}
              />

              {/* Donut */}
              {(() => {
                let start = 0;
                const cx = 130,
                  cy = 130,
                  rOuter = 105,
                  rInner = 65;
                return agg.map((slice, i) => {
                  const angle = (slice.value / total) * 360;
                  if (angle < 0.5) return null;
                  const path = donutSlicePath(
                    cx,
                    cy,
                    rOuter,
                    rInner,
                    start,
                    start + angle
                  );
                  const color = CHART_COLORS[i % CHART_COLORS.length];
                  const isHighlighted = hoveredIndex === i;
                  const midAngle = start + angle / 2;
                  const textRadius = rInner + (rOuter - rInner) * 0.55;
                  const chartRotation = -60;
                  const rotatedLabelPoint = polarToCartesian(
                    cx,
                    cy,
                    textRadius,
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
                        : 0.18
                      : hoveredIndex === null
                        ? 1
                        : isHighlighted
                          ? 1
                          : 0.82;
                  const pathShadow = isHighlighted
                    ? `drop-shadow(0 2px 6px ${makeShadowColor(color, 0.05)})`
                    : `drop-shadow(0 1px 3px ${makeShadowColor(color, 0.03)})`;
                  start += angle;
                  return (
                    <g key={slice.key}>
                      <g transform={`rotate(${chartRotation} ${cx} ${cy})`}>
                        <path
                          d={path}
                          fill={sliceFill}
                          fillOpacity={fillOpacity}
                          stroke="rgba(255,255,255,0.10)"
                          strokeWidth={1}
                          style={{
                            transition:
                              'opacity 0.2s ease, stroke-width 0.2s ease, fill-opacity 0.2s ease',
                            cursor:
                              slice.key === 'other' ? 'default' : 'pointer',
                            filter: pathShadow,
                          }}
                          onMouseEnter={() => setHoveredIndex(i)}
                          onMouseLeave={() => setHoveredIndex(null)}
                          onClick={() => handleLegendClick(slice)}
                        >
                          <title>{tooltipText}</title>
                        </path>
                      </g>
                      {showLabel && (
                        <text
                          x={rotatedLabelPoint.x}
                          y={rotatedLabelPoint.y}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="rgba(255,255,255,0.92)"
                          style={{
                            filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))',
                          }}
                          fontSize="10"
                          fontWeight={700}
                          pointerEvents="none"
                        >
                          {pct}%
                        </text>
                      )}
                    </g>
                  );
                });
              })()}

              {/* Center */}
              <circle cx={130} cy={130} r={52} fill="rgba(15,15,25,0.95)" />
              <circle
                cx={130}
                cy={130}
                r={52}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.08}
                strokeWidth={1}
              />
              <text
                x={130}
                y={124}
                textAnchor="middle"
                fill="var(--text-main)"
                fontSize={16}
                fontWeight={700}
              >
                {formatTotalTime(total)}
              </text>
              <text
                x={130}
                y={142}
                textAnchor="middle"
                fill="var(--text-sub)"
                fontSize={10}
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
                  {metric === 'artist' ? (
                    <img
                      src={artistThumbs[s.key] || image || ''}
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
                    <div className={styles.legendTitle}>{title}</div>
                    {subtitle && (
                      <div className={styles.legendSubtitle}>{subtitle}</div>
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
