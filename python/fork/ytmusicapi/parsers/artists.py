from ytmusicapi.navigation import *
from ytmusicapi.type_alias import JsonList
from .artist_cache import resolve_artists


def parse_artists_runs(runs: JsonList) -> JsonList:
    """Returns artist names and IDs. Skips every other run to avoid separators."""
    artists = []
    for j in range(int(len(runs) / 2) + 1):
        name = runs[j * 2]["text"]
        browse_id = nav(runs[j * 2], NAVIGATION_BROWSE_ID, True)
        artists.extend(resolve_artists(name, browse_id))
    return artists
