from ytmusicapi.helpers import to_int
from ytmusicapi.type_alias import JsonDict

from ._utils import *
from .artists import parse_artists_runs
from .songs import parse_like_status, parse_song_runs


def parse_album_header(response: JsonDict) -> JsonDict:
    header = nav(response, HEADER_DETAIL)
    album = {
        "title": nav(header, TITLE_TEXT),
        "type": nav(header, SUBTITLE),
        "thumbnails": nav(header, THUMBNAIL_CROPPED),
        "isExplicit": nav(header, SUBTITLE_BADGE_LABEL, True) is not None,
    }

    if "description" in header:
        album["description"] = header["description"]["runs"][0]["text"]

    album_info = parse_song_runs(header["subtitle"]["runs"][2:])
    album.update(album_info)

    if len(header["secondSubtitle"]["runs"]) > 1:
        album["trackCount"] = to_int(header["secondSubtitle"]["runs"][0]["text"])
        album["duration"] = header["secondSubtitle"]["runs"][2]["text"]
    else:
        album["duration"] = header["secondSubtitle"]["runs"][0]["text"]

    # add to library/uploaded
    menu = nav(header, MENU)
    toplevel = menu["topLevelButtons"]
    album["audioPlaylistId"] = nav(toplevel, [0, "buttonRenderer", *NAVIGATION_WATCH_PLAYLIST_ID], True)
    if not album["audioPlaylistId"]:
        album["audioPlaylistId"] = nav(toplevel, [0, "buttonRenderer", *NAVIGATION_PLAYLIST_ID], True)
    service = nav(toplevel, [1, "buttonRenderer", "defaultServiceEndpoint"], True)
    if service:
        album["likeStatus"] = parse_like_status(service)

    return album


def parse_album_header_2024(response: JsonDict) -> JsonDict:
    header = nav(response, [*TWO_COLUMN_RENDERER, *TAB_CONTENT, *SECTION_LIST_ITEM, *RESPONSIVE_HEADER])
    album = {
        "title": nav(header, TITLE_TEXT),
        "type": nav(header, SUBTITLE),
        "thumbnails": nav(header, THUMBNAILS),
        "isExplicit": nav(header, SUBTITLE_BADGE_LABEL, True) is not None,
    }

    album["description"] = nav(header, ["description", *DESCRIPTION_SHELF, *DESCRIPTION], True)

    album_info = parse_song_runs(header["subtitle"]["runs"][2:])
    strapline_runs = nav(header, ["straplineTextOne", "runs"], True)
    album_info["artists"] = parse_artists_runs(strapline_runs) if strapline_runs else None
    album.update(album_info)

    if len(header["secondSubtitle"]["runs"]) > 1:
        album["trackCount"] = to_int(header["secondSubtitle"]["runs"][0]["text"])
        album["duration"] = header["secondSubtitle"]["runs"][2]["text"]
    else:
        album["duration"] = header["secondSubtitle"]["runs"][0]["text"]

    # add to library/uploaded
    buttons = header["buttons"]
    album["audioPlaylistId"] = nav(
        find_object_by_key(buttons, "musicPlayButtonRenderer"),
        ["musicPlayButtonRenderer", "playNavigationEndpoint", *WATCH_PID],
        True,
    )
    # remove this once A/B testing is finished and it is no longer covered
    if album["audioPlaylistId"] is None:
        album["audioPlaylistId"] = nav(
            find_object_by_key(buttons, "musicPlayButtonRenderer"),
            ["musicPlayButtonRenderer", "playNavigationEndpoint", *WATCH_PLAYLIST_ID],
            True,
        )
    
    # Improved Like Status parsing for Albums (Bookmark icon)
    toggle_button = find_object_by_key(buttons, "toggleButtonRenderer")
    album["likeStatus"] = "INDIFFERENT"
    if toggle_button:
        renderer = toggle_button["toggleButtonRenderer"]
        default_icon = nav(renderer, ["defaultIcon", "iconType"], True)
        is_toggled = nav(renderer, ["isToggled"], True)
        if default_icon == "BOOKMARK" or (default_icon == "BOOKMARK_BORDER" and is_toggled):
            album["likeStatus"] = "LIKE"
        elif not is_toggled and default_icon == "BOOKMARK_BORDER":
            album["likeStatus"] = "INDIFFERENT"
        else:
            # fallback to service-based parsing
            service = nav(renderer, ["defaultServiceEndpoint"], True)
            if service:
                album["likeStatus"] = parse_like_status(service)

    # Extract menu tokens for pinning (2024 UI)
    more_button = find_object_by_key(buttons, "musicMoreButtonRenderer")
    menu = None
    if more_button:
        menu = nav(more_button, ["musicMoreButtonRenderer", "menu"], True)
    else:
        # Fallback: check if menuRenderer is directly in buttons
        menu_obj = find_object_by_key(buttons, "menuRenderer")
        if menu_obj:
            menu = menu_obj

    if menu:
        from .browsing import parse_menu_tokens
        # result needs to have a 'menu' key for parse_menu_tokens to work
        # if menu already has 'menuRenderer', we wrap it
        if "menuRenderer" in menu:
            tokens, pinned, home_like, _, _ = parse_menu_tokens({"menu": menu})
        else:
            tokens, pinned, home_like, _, _ = parse_menu_tokens(menu)
            
        album["menu_tokens"] = tokens
        album["isPinned"] = pinned
        if home_like and album["likeStatus"] == "INDIFFERENT":
            album["likeStatus"] = home_like

    return album


def parse_album_playlistid_if_exists(data: JsonDict | None) -> str | None:
    """the content of the data changes based on whether the user is authenticated or not"""
    return nav(data, WATCH_PID, True) or nav(data, WATCH_PLAYLIST_ID, True) if data else None
