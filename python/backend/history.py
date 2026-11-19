"""History entries and playback/watch-time reports."""
import sys


def add_history_item(request, ctx):
    api = ctx.get_api()
    video_id = request.get('videoId')
    try:
        # Согласно инструкции пользователя:
        # song = yt_auth.get_song(videoId)
        # response = yt_auth.add_history_item(song)
        song = api.get_song(video_id)
        response = api.add_history_item(song)

        if response.status_code == 204:
            print(f"YT history sent for {video_id}", file=sys.stderr)
            ctx.emit({'status': 'ok', 'code': 204})
        else:
            print(f"Failed to send YT history for {video_id}: {response.status_code}", file=sys.stderr)
            ctx.emit({'status': 'error', 'code': response.status_code})
    except Exception as e:
        print(f"Error adding history item for {video_id}: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def send_playback(request, ctx, *, stats):
    # Запись в историю YouTube. Тот же cpn потом несут пинги watchtime: так YouTube
    # складывает время прослушивания к этой записи, и трек попадает в Listen again и
    # рекомендации. Раньше история шла отдельным add_history_item со своим cpn, а
    # watchtime голым requests без кук: YouTube видел запись с нулём секунд.
    pb_url = request.get('playbackUrl')
    if not pb_url:
        ctx.emit({'status': 'error', 'message': 'No playbackUrl'})
    else:
        code = stats(pb_url, {'cpn': request.get('cpn'), 'fmt': 251, 'rt': 0, 'rtn': 0})
        print(f"[watchtime] playback -> {code}", file=sys.stderr)
        ctx.emit({'status': 'ok', 'httpStatus': code})


def send_watchtime(request, ctx, *, stats):
    wt_url = request.get('watchtimeUrl')
    if not wt_url:
        ctx.emit({'status': 'error', 'message': 'No watchtimeUrl'})
    else:
        rt = request.get('rt', 0)
        params = {
            'fmt': 0, 'fs': 0, 'euri': '',
            'cbr': 'Chrome', 'cbrver': '134.0.0.0',
            'cplayer': 'UNIPLAYER', 'cos': 'Windows', 'cosver': '10.0',
            'cplatform': 'DESKTOP', 'hl': 'en_US',
            'afmt': 140, 'muted': 0, 'vis': 10, 'volume': 100,
            'cpn': request.get('cpn'),
            'cmt': request.get('cmt'),
            'st': request.get('st'),
            'et': request.get('et'),
            'state': request.get('state', 'playing'),
            'len': request.get('len'),
            'rt': rt,
            'rtn': round(rt + 40, 3),
            'rti': rt,
            'lact': request.get('lact', 0),
        }
        code = stats(wt_url, params)
        print(f"[watchtime] {request.get('state')} cmt={request.get('cmt')} -> {code}", file=sys.stderr)
        ctx.emit({'status': 'ok', 'httpStatus': code})
