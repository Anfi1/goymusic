import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { TableVirtuoso, VirtuosoHandle } from 'react-virtuoso';
import { player } from '../../api/player';
import { historyStore, HistoryEntry } from '../../api/history';
import { likedStore } from '../../api/likedStore';
import { TrackRow } from '../molecules/TrackRow';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';
import { Clock, Trash2, Calendar as CalendarIcon, Search, Heart, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import styles from './HistoryView.module.css';
import trackStyles from '../molecules/TrackRow.module.css';

type HistoryItem = 
  | { type: 'header', date: string }
  | { type: 'track', entry: HistoryEntry, index: number };

interface DateRange {
  start: Date | null;
  end: Date | null;
}

const HistorySearch = memo(({ onSearch }: { onSearch: (q: string) => void }) => {
  const [localQuery, setLocalQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => onSearch(localQuery), 300);
    return () => clearTimeout(timer);
  }, [localQuery, onSearch]);

  return (
    <div className={styles.searchWrapper}>
      <Search size={16} className={styles.searchIcon} />
      <input 
        type="text" 
        placeholder="Search tracks or artists..." 
        className={styles.searchInput} 
        value={localQuery} 
        onChange={(e) => setLocalQuery(e.target.value)} 
      />
    </div>
  );
});

const CalendarPicker = memo(({ range, onChange, minDate, maxDate, onClose }: { 
  range: DateRange, 
  onChange: (r: DateRange) => void,
  minDate?: Date,
  maxDate?: Date,
  onClose: () => void 
}) => {
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const [currentDate, setCurrentDate] = useState(new Date());
  
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const daysInMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const startDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();

  const isSameDay = (d1: Date | null, d2: Date | null) => 
    d1 && d2 && d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();

  const isInRange = (date: Date) => {
    if (!range.start || !range.end) return false;
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const s = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()).getTime();
    const e = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate()).getTime();
    return d > s && d < e;
  };

  const handleDayClick = (day: number) => {
    const clicked = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    if (!range.start || (range.start && range.end)) {
      onChange({ start: clicked, end: null });
    } else {
      if (clicked < range.start) onChange({ start: clicked, end: range.start });
      else onChange({ start: range.start, end: clicked });
    }
  };

  const isDateDisabled = (date: Date) => {
    if (minDate && date < new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate())) return true;
    if (maxDate && date > new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate())) return true;
    return false;
  };

  const changeMonth = (delta: number) => {
    setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + delta)));
  };

  const changeYear = (delta: number) => {
    setCurrentDate(new Date(currentDate.setFullYear(currentDate.getFullYear() + delta)));
  };

  const renderDays = () => {
    const days = [];
    const totalDays = daysInMonth(currentDate);
    const offset = (startDay(currentDate) + 6) % 7;
    for (let i = 0; i < offset; i++) days.push(null);
    for (let i = 1; i <= totalDays; i++) days.push(i);

    return (
      <>
        <div className={styles.calendarGrid}>
          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => <div key={d} className={styles.weekday}>{d}</div>)}
          {days.map((day, idx) => {
            if (day === null) return <div key={`empty-${idx}`} />;
            const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
            const isSelectedStart = isSameDay(date, range.start);
            const isSelectedEnd = isSameDay(date, range.end);
            const inR = isInRange(date);
            const disabled = isDateDisabled(date);
            
            return (
              <div 
                key={day} 
                className={`${styles.dayCell} ${isSelectedStart ? styles.rangeStart : ''} ${isSelectedEnd ? styles.rangeEnd : ''} ${inR ? styles.inRange : ''} ${disabled ? styles.disabled : ''} ${isSameDay(date, new Date()) ? styles.today : ''}`}
                onClick={() => !disabled && handleDayClick(day)}
              >
                {day}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const renderMonths = () => (
    <div className={styles.monthGrid}>
      {monthNames.map((name, i) => (
        <div 
          key={name} 
          className={`${styles.selectionItem} ${currentDate.getMonth() === i ? styles.selectionItemActive : ''}`}
          onClick={() => {
            setCurrentDate(new Date(currentDate.setMonth(i)));
            setView('days');
          }}
        >
          {name.slice(0, 3)}
        </div>
      ))}
    </div>
  );

  const renderYears = () => {
    const startYear = currentDate.getFullYear() - 4;
    const years = Array.from({ length: 9 }, (_, i) => startYear + i);
    return (
      <div className={styles.yearGrid}>
        {years.map(y => (
          <div 
            key={y} 
            className={`${styles.selectionItem} ${currentDate.getFullYear() === y ? styles.selectionItemActive : ''}`}
            onClick={() => {
              setCurrentDate(new Date(currentDate.setFullYear(y)));
              setView('months');
            }}
          >
            {y}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={styles.calendarPopover}>
      <div className={styles.calendarHeader}>
        <button className={styles.navBtn} onClick={() => view === 'days' ? changeMonth(-1) : view === 'months' ? changeYear(-1) : changeYear(-9)}>
          <ChevronLeft size={16}/>
        </button>
        <h4 onClick={() => setView(view === 'days' ? 'months' : 'years')}>
          {view === 'days' ? currentDate.toLocaleString('default', { month: 'long', year: 'numeric' }) : view === 'months' ? currentDate.getFullYear() : `${currentDate.getFullYear() - 4} - ${currentDate.getFullYear() + 4}`}
        </h4>
        <button className={styles.navBtn} onClick={() => view === 'days' ? changeMonth(1) : view === 'months' ? changeYear(1) : changeYear(9)}>
          <ChevronRight size={16}/>
        </button>
      </div>
      
      {view === 'days' && renderDays()}
      {view === 'months' && renderMonths()}
      {view === 'years' && renderYears()}

      <div className={styles.calendarFooter}>
        <button className={styles.btnReset} onClick={() => { onChange({ start: null, end: null }); onClose(); }}>Reset</button>
        <button className={styles.btnApply} onClick={onClose}>Apply</button>
      </div>
    </div>
  );
});

const HistoryTable = React.forwardRef(({ context, ...props }: any, ref: any) => (
  <table {...props} ref={ref} className={styles.table} />
));

const HistoryTableRow = React.forwardRef((props: any, ref: any) => {
  const { item, context, ...rest } = props;

  const [isActive, setIsActive] = useState(player.currentTrack?.id === item?.entry?.track?.id);

  useEffect(() => {
    if (!item?.entry?.track?.id) return;
    return player.subscribe((event) => {
      if (event === 'state') {
        const isMe = player.currentTrack?.id === item?.entry?.track?.id;
        setIsActive(prev => prev !== isMe ? isMe : prev);
      }
    });
  }, [item?.entry?.track?.id]);

  if (!item) return <tr {...rest} ref={ref} />;

  const isHeader = item.type === 'header';

  const handleClick = useCallback(() => {
    if (item.type === 'track') context.onPlay(item.index);
  }, [item, context]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (item.type === 'track') {
      e.preventDefault();
      context.onContextMenu(e, item.entry.track, { timestamp: item.entry.timestamp });
    }
  }, [item, context]);

  return (
    <tr
      {...rest}
      ref={ref}
      className={`${isHeader ? styles.dateRow : trackStyles.row} ${!isHeader && isActive ? trackStyles.active : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    />
  );
});
const HistoryRowContent = memo(({ item, onSelectArtist, onSelectAlbum }: {
  item: HistoryItem;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
}) => {
  if (item.type === 'header') return <td colSpan={5} className={styles.dateCell}>{item.date}</td>;
  const { entry, index: filteredIdx } = item;

  const timeStr = useMemo(() => {
    return new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }, [entry.timestamp]);

  const extraCells = useMemo(() => [
    <td key="played-at" className={styles.timeCell}>{timeStr}</td>
  ], [timeStr]);

  return (
    <TrackRow
      {...entry.track}
      index={filteredIdx + 1}
      renderOnlyCells={true}
      extraCells={extraCells}
      onSelectArtist={onSelectArtist}
      onSelectAlbum={onSelectAlbum}
    />
  );
});

interface HistoryViewProps {
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = memo(({ onSelectArtist, onSelectAlbum }) => {
  const [rawHistory, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyLiked, setShowOnlyLiked] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null });
  const [showCalendar, setShowCalendar] = useState(false);
  
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);

  const fetchHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await historyStore.getHistory(3000);
      const allLikedTracks = await likedStore.getAllTracks();
      const likedIds = new Set(allLikedTracks.map(t => t.videoId));
      
      const hydratedData = data.map(entry => {
        if (likedIds.has(entry.track.id)) {
            return { ...entry, track: { ...entry.track, likeStatus: 'LIKE' as const } };
        } else if (entry.track.likeStatus === 'LIKE') {
            return { ...entry, track: { ...entry.track, likeStatus: 'INDIFFERENT' as const } };
        }
        return entry;
      });
      
      setHistory(hydratedData || []);
    } catch (e) { console.error(e); } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  useEffect(() => {
    const handleLikeUpdate = (e: any) => {
      if (e.detail.status === 'success') {
        setHistory(prev => {
          let changed = false;
          const next = prev.map(item => {
            if (item.track.id === e.detail.id && item.track.likeStatus !== e.detail.likeStatus) {
              changed = true;
              return { ...item, track: { ...item.track, likeStatus: e.detail.likeStatus } };
            }
            return item;
          });
          return changed ? next : prev;
        });
      }
    };
    window.addEventListener('track-like-updated', handleLikeUpdate as EventListener);
    return () => window.removeEventListener('track-like-updated', handleLikeUpdate as EventListener);
  }, []);

  const minMaxDates = useMemo(() => {
    if (rawHistory.length === 0) return { min: undefined, max: undefined };
    const timestamps = rawHistory.map(h => h.timestamp);
    return { min: new Date(Math.min(...timestamps)), max: new Date(Math.max(...timestamps)) };
  }, [rawHistory]);

  const filteredHistory = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return rawHistory.filter(item => {
      if (q) {
        const titleMatch = item.track.title.toLowerCase().includes(q);
        const artistMatch = item.track.artists?.some(a => a.toLowerCase().includes(q));
        if (!titleMatch && !artistMatch) return false;
      }
      if (showOnlyLiked && item.track.likeStatus !== 'LIKE') return false;
      if (dateRange.start) {
        const d = new Date(item.timestamp);
        const start = new Date(dateRange.start.getFullYear(), dateRange.start.getMonth(), dateRange.start.getDate());
        if (d < start) return false;
        if (dateRange.end) {
          const end = new Date(dateRange.end.getFullYear(), dateRange.end.getMonth(), dateRange.end.getDate(), 23, 59, 59);
          if (d > end) return false;
        } else {
          const endOfDay = new Date(start.getTime() + 86400000);
          if (d >= endOfDay) return false;
        }
      }
      return true;
    });
  }, [rawHistory, searchQuery, showOnlyLiked, dateRange]);

  const flatList = useMemo(() => {
    const items: HistoryItem[] = [];
    let lastDate = '';
    filteredHistory.forEach((entry, idx) => {
      const date = new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      if (date !== lastDate) { items.push({ type: 'header', date }); lastDate = date; }
      items.push({ type: 'track', entry, index: idx });
    });
    return items;
  }, [filteredHistory]);

  const handlePlayTrack = useCallback((idx: number) => {
    player.playTrackList(filteredHistory.map(h => h.track), idx, 'history');
  }, [filteredHistory]);

  const handleContextMenu = useCallback((e: any, t: any, options?: any) => {
    trackMenuRef.current?.open(e, t, { 
      ...options,
      onRemoveFromHistory: (ts: number) => {
        setHistory(prev => prev.filter(h => h.timestamp !== ts));
      }
    });
  }, []);

  const virtuosoContext = useMemo(() => ({
    onPlay: handlePlayTrack,
    onContextMenu: handleContextMenu,
    onSelectArtist,
    onSelectAlbum,
  }), [handlePlayTrack, handleContextMenu, onSelectArtist, onSelectAlbum]);

  const components = useMemo(() => ({
    Table: HistoryTable,
    TableRow: HistoryTableRow
  }), []);

  if (isLoading) return <div className={styles.container}><div className={styles.loading}><Loader2 className="animate-spin" size={32} /><span>Loading history...</span></div></div>;

  const rangeLabel = dateRange.start ? 
    `${dateRange.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${dateRange.end ? ' - ' + dateRange.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}` 
    : 'All Time';

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerInfo}>
          <div className={styles.iconCircle}><Clock size={24} /></div>
          <div><h1>History</h1><p>{filteredHistory.length} tracks found</p></div>
        </div>
        <button className={styles.btnClear} onClick={() => confirm('Clear history?') && historyStore.clearAll().then(() => setHistory([]))}><Trash2 size={16} /><span>Clear All</span></button>
      </header>

      <div className={styles.controls}>
        <HistorySearch onSearch={setSearchQuery} />
        <div className={styles.filterGroup}>
          <button className={`${styles.filterBtn} ${showOnlyLiked ? styles.filterBtnActive : ''}`} onClick={() => setShowOnlyLiked(!showOnlyLiked)}><Heart size={14} fill={showOnlyLiked ? "currentColor" : "none"} /><span>Liked</span></button>
          
          <div className={styles.dateFilterWrapper}>
            <button className={`${styles.filterBtn} ${dateRange.start ? styles.filterBtnActive : ''}`} onClick={() => setShowCalendar(!showCalendar)}>
              <CalendarIcon size={14} />
              <span>{rangeLabel}</span>
            </button>
            {showCalendar && (
              <CalendarPicker 
                range={dateRange} 
                onChange={setDateRange} 
                minDate={minMaxDates.min} 
                maxDate={minMaxDates.max}
                onClose={() => setShowCalendar(false)} 
              />
            )}
          </div>
        </div>
      </div>

      <div className={styles.listContainer}>
        {flatList.length === 0 ? <div className={styles.empty}><CalendarIcon size={48} /><h3>Nothing found</h3></div> : (
          <TableVirtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={flatList}
            context={virtuosoContext}
            fixedHeaderContent={() => (
              <tr className={styles.tableHeader}>
                <th style={{ width: 50 }}>#</th>
                <th style={{ width: '40%' }}>Title</th>
                <th style={{ width: '25%' }}>Album</th>
                <th style={{ width: 100 }}>Played</th>
                <th style={{ textAlign: 'right', width: 80, paddingRight: '24px' }}>Time</th>
              </tr>
            )}
            itemContent={(idx, item, ctx) => <HistoryRowContent item={item} onSelectArtist={ctx?.onSelectArtist} onSelectAlbum={ctx?.onSelectAlbum} />}
            components={components}
          />
        )}
      </div>
      <TrackContextMenu ref={trackMenuRef} />
    </div>
  );
});

export default HistoryView;
