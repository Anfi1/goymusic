import { Fragment } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canLookUpVideo, creditForVideo, loadVideoCard } from '../../api/trackCredits';
import { useToast } from '../atoms/Toast';

interface Props {
  videoId?: string;
  source?: unknown;
  artists?: string[];
  artistIds?: string[];
  linkClass: string;
  onSelectArtist?: (id: string) => void;
}

export function TrackCredits({ videoId, source, artists, artistIds, linkClass, onSelectArtist }: Props) {
  const client = useQueryClient();
  const { showToast } = useToast();
  return artists?.map((name, index) => {
    const knownId = artistIds?.[index];
    const linked = onSelectArtist && (knownId || canLookUpVideo(videoId, source));
    return <Fragment key={`${videoId}:${index}`}>
      {linked ? <span role="link" tabIndex={0} className={linkClass} data-tooltip={name} data-tooltip-overflow=""
        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); e.currentTarget.click(); } }}
        onClick={async e => {
          e.stopPropagation();
          if (knownId) { onSelectArtist(knownId); return; }
          const element = e.currentTarget;
          if (!videoId) return;
          const id = creditForVideo(videoId, name, await loadVideoCard(client, videoId));
          if (!element.isConnected || element.textContent !== name) return;
          if (id) onSelectArtist(id);
          else showToast('Artist profile unavailable', 'info');
        }}>{name}</span> : name}
      {index < artists.length - 1 && ', '}
    </Fragment>;
  });
}
