import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Play, Pause } from 'lucide-react';
import { ProgressBar, ProgressBarRef } from '../atoms/ProgressBar';
import { player } from '../../api/player';
import { useToast } from '../atoms/Toast';
import styles from './ShareDialog.module.css';

interface ShareDialogProps {
  isOpen: boolean;
  link: string;
  onClose: () => void;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!isNaN(m) && !isNaN(s) && m >= 0 && s >= 0 && s < 60) return m * 60 + s;
  } else {
    const t = parseInt(trimmed, 10);
    if (!isNaN(t) && t >= 0) return t;
  }
  return null;
}

export const ShareDialog: React.FC<ShareDialogProps> = ({
  isOpen, link, onClose
}) => {
  const [useTimecode, setUseTimecode] = useState(false);
  const [manualTime, setManualTime] = useState('');
  const [isPlaying, setIsPlaying] = useState(player.isPlaying);
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(0);
  const progressBarRef = useRef<ProgressBarRef>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isOpen) return;

    setUseTimecode(false);
    setManualTime('');
    setIsPlaying(player.isPlaying);
    setCopied(false);

    const interval = setInterval(() => setTick(t => t + 1), 1000);

    const updateTime = () => {
      if (currentRef.current) currentRef.current.textContent = formatTime(player.currentTime);
      if (durationRef.current) durationRef.current.textContent = formatTime(player.duration);
      if (progressBarRef.current) {
        const pct = player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0;
        progressBarRef.current.setProgress(pct);
      }
    };

    const unsub = player.subscribe((ev) => {
      if (ev === 'tick' || ev === 'buffer') updateTime();
      else if (ev === 'state') {
        setIsPlaying(player.isPlaying);
        updateTime();
      }
    }, { tick: true, buffer: true });

    updateTime();
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const manualTimeSec = parseTimeInput(manualTime);
  const timecodeValue = useTimecode
    ? (manualTimeSec !== null ? manualTimeSec : Math.floor(player.currentTime))
    : 0;

  const fullLink = useTimecode && timecodeValue > 0
    ? `${link}&t=${timecodeValue}`
    : link;

  const handleSeek = useCallback((pct: number) => {
    if (player.duration) player.seek((pct / 100) * player.duration);
  }, []);

  const handleTogglePlay = () => player.togglePlay();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(fullLink);
    setCopied(true);
    showToast('Link copied!', 'success');
    setTimeout(() => {
      setCopied(false);
      onClose();
    }, 400);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter') handleCopy();
  };

  const handleLinkClick = () => {
    linkRef.current?.select();
  };

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <h3 className={styles.title}>Share Track</h3>

        <div className={styles.playerRow}>
          <button className={styles.playBtn} onClick={handleTogglePlay}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span ref={currentRef} className={styles.time}>{formatTime(player.currentTime)}</span>
          <ProgressBar
            ref={progressBarRef}
            buffered={player.buffered}
            onSeek={handleSeek}
            className={styles.progressBar}
            nyanMode={true}
            isPlaying={isPlaying}
          />
          <span ref={durationRef} className={styles.time}>{formatTime(player.duration)}</span>
        </div>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={useTimecode}
            onChange={e => setUseTimecode(e.target.checked)}
          />
          <span className={styles.checkmark} />
          <span>Start from time</span>
        </label>

        {useTimecode && (
          <div className={styles.timeInputRow}>
            <input
              className={styles.timeInput}
              value={manualTime}
              onChange={e => setManualTime(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={formatTime(player.currentTime)}
            />
            <span className={styles.timeHint}>
              {manualTimeSec !== null
                ? `from ${formatTime(manualTimeSec)}`
                : `from ${formatTime(player.currentTime)} (current)`}
            </span>
          </div>
        )}

        <div className={styles.linkRow}>
          <input
            ref={linkRef}
            className={styles.linkInput}
            value={fullLink}
            readOnly
            onClick={handleLinkClick}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.copyBtn} onClick={handleCopy}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
