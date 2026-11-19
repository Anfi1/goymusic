"""Account metadata and account-aware playlist formatting."""
import sys
import threading


# Кеш данных аккаунта и блокировка для предотвращения двойных запросов
_ACCOUNT_CACHE = None
_account_lock = threading.Lock()

def fetch_account_info(get_api):
    global _ACCOUNT_CACHE, OWNER_ID
    with _account_lock:
        if _ACCOUNT_CACHE:
            return _ACCOUNT_CACHE
        
        try:
            api = get_api()
            # Наш форк возвращает channelId, accountName, accountPhotoUrl, channelHandle
            info = api.get_account_info()
            _ACCOUNT_CACHE = info
            
            # Сразу обновляем глобальный OWNER_ID, если он пришел
            if info.get('channelId'):
                OWNER_ID = info['channelId']
                
            return info
        except Exception as e:
            print(f"Error fetching account info: {e}", file=sys.stderr)
            return {}

# Глобальный кеш ID владельца для проверки владения плейлистами
OWNER_ID = None

def get_owner_id(get_api):
    global OWNER_ID
    if OWNER_ID:
        return OWNER_ID
    
    # fetch_account_info автоматически обновит OWNER_ID если channelId там есть
    fetch_account_info(get_api)
    return OWNER_ID

def playlist_to_dict(get_api, p, skip_owner_check=False):
    try:
        p_id = p.get('playlistId') or p.get('id') or p.get('browseId')
        if not p_id:
            return None

        # Обработка автора
        author_data = p.get('author')
        author = None
        artist_names = []
        artist_ids = []

        if isinstance(author_data, list):
            author = [{'name': a.get('name'), 'id': a.get('id') or a.get('browseId')} for a in author_data]
            artist_names = [a.get('name') for a in author_data]
            artist_ids = [a.get('id') or a.get('browseId') for a in author_data]
        elif isinstance(author_data, dict):
            author = {'name': author_data.get('name'), 'id': author_data.get('id') or author_data.get('browseId')}
            artist_names = [author_data.get('name')]
            artist_ids = [author_data.get('id') or author_data.get('browseId')]
        elif isinstance(author_data, str):
            author = {'name': author_data, 'id': None}
            artist_names = [author_data]

        res_thumb = ''
        thumbs = p.get('thumbnails')
        if thumbs:
            res_thumb = thumbs[-1].get('url')

        # Определение владения и возможности добавления
        is_owned = p.get('owned', False)
        can_add = True

        # Специальные случаи
        if p_id == 'LM':
            is_owned = True
            can_add = False # В "Понравившиеся" добавляем через Like, а не через плейлист
        elif p_id.startswith('LRYR'):
            is_owned = False
            can_add = False # Рекапы нельзя редактировать

        if not skip_owner_check and not is_owned:
            # Проверяем по ID автора (использует кеш после первого вызова)
            my_id = get_owner_id(get_api)
            if my_id:
                if isinstance(author, list):
                    is_owned = any(a.get('id') == my_id for a in author)
                elif isinstance(author, dict):
                    is_owned = author.get('id') == my_id
            # Фолбек по имени — только если кеш уже есть (не делаем новый HTTP запрос)
            if not is_owned and _ACCOUNT_CACHE:
                my_name = _ACCOUNT_CACHE.get('accountName')
                if my_name:
                    if isinstance(author, list):
                        is_owned = any(a.get('name') == my_name for a in author)
                    elif isinstance(author, dict):
                        is_owned = author.get('name') == my_name

        return {
            'id': p_id,
            'title': p.get('title'),
            'author': author,
            'artists': artist_names,
            'artistIds': artist_ids,
            'itemCount': p.get('count') or p.get('itemCount'),
            'thumbUrl': res_thumb,
            'owned': is_owned,
            'can_add': can_add and is_owned, # Можно добавлять только в свои и не-системные
            'menu_tokens': p.get('menu_tokens'),
            'isPinned': p.get('isPinned', False),
            'description': p.get('description')
        }
    except Exception:
        return None
