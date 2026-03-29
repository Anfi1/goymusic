import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, X, Volume2 } from 'lucide-react';
import { player } from '../../api/player';
import styles from './MiniPreviewPlayer.module.css';

interface Props {
  streamUrl: string;
  onClose?: () => void;
}

export const MiniPreviewPlayer: React.FC<Props> = ({ streamUrl, onClose }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [volume, setVolume] = useState(player.volume);

  useEffect(() => {
    const unsub = player.subscribe((ev) => {
      if (ev === 'state') {
        setVolume(player.volume);
        if (audioRef.current) {
          audioRef.current.volume = player.volume / 100;
        }
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!streamUrl) return;

    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = streamUrl;
    audio.volume = player.volume / 100;
    audioRef.current = audio;
    setErrorMsg(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);

    const handleLoadedMetadata = () => setDuration(audio.duration);
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    
    const handleError = () => {
      // Игнорируем ошибку, если src был очищен намеренно
      if (!audio.src || audio.src === window.location.href) return;

      const err = audio.error;
      let msg = 'Неизвестная ошибка';
      if (err) {
        switch (err.code) {
          case 1: msg = 'Загрузка прервана'; break;
          case 2: msg = 'Ошибка сети (CORS?)'; break;
          case 3: msg = 'Ошибка декодирования'; break;
          case 4: msg = 'Доступ запрещен или формат не поддерживается'; break;
        }
      }
      console.error('[MiniPlayer] Audio Error:', {
        code: err?.code,
        message: err?.message,
        url: streamUrl
      });
      setErrorMsg(msg);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    // Принудительная загрузка
    audio.load();

    if (player.isPlaying) player.togglePlay();

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audio.src = '';
      audio.load();
    };
  }, [streamUrl]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((e) => {
        console.error('[MiniPlayer] Playback failed:', e);
        setErrorMsg(`Ошибка воспроизведения: ${e.message}`);
      });
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = parseFloat(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    player.setVolume(val);
  };

  const formatTime = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className={styles.container}>
      <button className={styles.playBtn} onClick={togglePlay} disabled={!!errorMsg}>
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className={styles.timeline}>
        {errorMsg ? (
          <span className={styles.errorText} title={streamUrl}>{errorMsg}</span>
        ) : (
          <>
            <span className={styles.time}>{formatTime(currentTime)}</span>
            <input
              type="range"
              className={styles.scrubber}
              min={0}
              max={duration || 1}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
            />
            <span className={styles.time}>{formatTime(duration)}</span>
          </>
        )}
      </div>
      <div className={styles.volumeContainer}>
        <Volume2 size={14} className={styles.volumeIcon} />
        <input
          type="range"
          className={styles.volumeSlider}
          min={0}
          max={100}
          value={volume}
          onChange={handleVolumeChange}
        />
      </div>
      {onClose && (
        <button className={styles.closeBtn} onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  );
};
