export type ViewType = 'liked' | 'playlist' | 'search' | 'settings' | 'auth' | 'artist' | 'album' | 'home' | 'history' | 'new-releases' | 'radio';

export interface ActiveView {
  type: ViewType;
  playlistId?: string;
  playlistTitle?: string;
  searchQuery?: string;
  artistId?: string;
  albumId?: string;
}
