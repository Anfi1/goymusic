from ytmusicapi.navigation import *
from ytmusicapi.type_alias import JsonList
from .artist_cache import store, lookup_with_separators


def parse_artists_runs(runs: JsonList) -> JsonList:
    """Returns artist names and IDs. Skips every other run to avoid separators."""
    artists = []
    for j in range(int(len(runs) / 2) + 1):
        name = runs[j * 2]["text"]
        browse_id = nav(runs[j * 2], NAVIGATION_BROWSE_ID, True)
        if browse_id:
            store(name, browse_id)
        else:
            browse_id = lookup_with_separators(name)
        artists.append({"name": name, "id": browse_id})
    return artists
