import React, { useState, useEffect, useRef, memo } from 'react';
import { Sun, Moon, Minus, Square, Copy, X, ChevronLeft, RefreshCw, Search, Loader2 } from 'lucide-react';
import { IconButton } from '../atoms/IconButton';
import { EqualizerMenu } from '../molecules/EqualizerMenu';
import { getSearchSuggestions } from '../../api/yt';
import styles from './TitleBar.module.css';

interface TitleBarProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onBack?: () => void;
  onRefresh?: () => void;
  onSearch?: (query: string) => void;
  canGoBack?: boolean;
  activeSearchQuery?: string;
  isInitializing?: boolean;
}

const NO_DRAG_STYLE = { 'WebkitAppRegion': 'no-drag' } as any;

const WindowMaximizeButton = memo(() => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    return window.bridge.onWindowState((state) => {
      setIsMaximized(state.isMaximized);
    });
  }, []);

  return (
    <IconButton 
      icon={isMaximized ? Copy : Square} 
      size={28} 
      iconSize={isMaximized ? 10 : 12} 
      onClick={() => window.bridge.winMaximize()} 
      className={styles.controlBtn} 
      title={isMaximized ? "Restore" : "Maximize"} 
    />
  );
});

export const TitleBar: React.FC<TitleBarProps> = memo(({ 
  theme, 
  onToggleTheme,
  onBack,
  onRefresh,
  onSearch,
  canGoBack = false,
  activeSearchQuery = '',
  isInitializing = false
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchQuery(activeSearchQuery);
  }, [activeSearchQuery]);

  useEffect(() => {
    if (isInitializing || searchQuery.trim().length <= 1) {
      setSuggestions([]);
      setIsLoadingSuggestions(false);
      return;
    }
    setIsLoadingSuggestions(true);
    setSelectedIndex(-1);
    const debounce = setTimeout(async () => {
      try {
        const results = await getSearchSuggestions(searchQuery.trim());
        setSuggestions(results);
      } catch {
        setSuggestions([]);
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, isInitializing]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setSelectedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (e?: React.FormEvent, forcedQuery?: string) => {
    e?.preventDefault();
    if (isInitializing) return;
    const query = forcedQuery ?? (selectedIndex >= 0 ? suggestions[selectedIndex] : searchQuery);
    if (query.trim() && onSearch) {
      setShowSuggestions(false);
      setSelectedIndex(-1);
      if (selectedIndex >= 0) setSearchQuery(suggestions[selectedIndex]);
      onSearch(query.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIndex(-1);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setSearchQuery(suggestion);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    if (suggestion.trim() && onSearch) onSearch(suggestion.trim());
  };

  return (
    <header className={styles.titleBar}>
      {/* Left: Navigation Controls */}
      <div className={styles.leftControls} style={NO_DRAG_STYLE}>
        {!isInitializing && onBack && (
          <IconButton 
            icon={ChevronLeft} 
            size={24} 
            iconSize={16} 
            onClick={onBack}
            disabled={!canGoBack}
            title="Go Back"
          />
        )}
        {!isInitializing && onRefresh && (
          <IconButton 
            icon={RefreshCw} 
            size={24} 
            iconSize={14} 
            onClick={onRefresh}
            title="Refresh View"
          />
        )}
      </div>

      {/* Center: Search Area / Loading Title */}
      <div className={styles.searchRegion} style={NO_DRAG_STYLE}>
        {!isInitializing ? (
          <div ref={searchContainerRef} className={styles.searchWrapper}>
            <form onSubmit={handleSearchSubmit} className={styles.searchForm}>
              <div className={styles.inputIconWrapper}>
                {isLoadingSuggestions
                  ? <Loader2 size={13} className={styles.searchIconSpinner} />
                  : <Search size={14} className={styles.searchIcon} />
                }
                <input
                  type="text"
                  value={searchQuery}
                  onFocus={() => { if (searchQuery.trim().length > 1) setShowSuggestions(true); }}
                  onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); }}
                  onKeyDown={handleKeyDown}
                  placeholder="Search songs, artists..."
                  className={styles.searchInput}
                />
              </div>
            </form>

            {showSuggestions && searchQuery.trim().length > 1 && (isLoadingSuggestions || suggestions.length > 0) && (
              <div className={styles.suggestionsDropdown}>
                {isLoadingSuggestions && suggestions.length === 0 ? (
                  <div className={styles.suggestionLoading}>
                    <Loader2 size={12} className={styles.searchIconSpinner} />
                    <span>Searching...</span>
                  </div>
                ) : suggestions.map((s, i) => (
                  <div
                    key={i}
                    className={`${styles.suggestionItem} ${i === selectedIndex ? styles.suggestionSelected : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSuggestionClick(s)}
                  >
                    <Search size={12} className={styles.suggestionIcon} />
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className={styles.loadingTitle}>GoyMusic</div>
        )}
      </div>

      {/* Right: Window Controls */}
      <div className={styles.windowControls} style={NO_DRAG_STYLE}>
        {!isInitializing && <EqualizerMenu />}
        <IconButton
          icon={theme === 'dark' ? Sun : Moon}
          size={28}
          iconSize={14}
          onClick={onToggleTheme}
          className={styles.themeToggle}
          title="Toggle Theme"
        />
        <div className={styles.divider} />
        <IconButton 
          icon={Minus} size={28} iconSize={14} 
          onClick={() => window.bridge.winMinimize()} 
          className={styles.controlBtn} 
          title="Minimize" 
        />
        <WindowMaximizeButton />
        <IconButton 
          icon={X} size={28} iconSize={14} 
          onClick={() => window.bridge.winClose()} 
          className={`${styles.controlBtn} ${styles.closeBtn}`} 
          title="Close" 
        />
      </div>
    </header>
  );
});

TitleBar.displayName = 'TitleBar';
