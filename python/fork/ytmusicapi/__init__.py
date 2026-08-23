from importlib.metadata import PackageNotFoundError, version

from ytmusicapi.auth.oauth.credentials import OAuthCredentials
from ytmusicapi.models.content.enums import LikeStatus
from ytmusicapi.setup import setup, setup_oauth
from ytmusicapi.ytmusic import YTMusic

try:
    __version__ = version("ytmusicapi")
except PackageNotFoundError:
    # package is not installed
    pass

# Версия upstream, до которой руками поднят этот вендоренный форк.
# __version__ выше читается из метаданных УСТАНОВЛЕННОГО пакета и про код форка не
# говорит ничего — после ручного синка он остаётся старым и вводит в заблуждение.
# Обновлять вместе с каждым синком (последний: коммит 35f34f6, 1.11.5 -> 1.12.2).
__fork_upstream_version__ = "1.12.2"

__copyright__ = "Copyright 2024 sigma67"
__license__ = "MIT"
__title__ = "ytmusicapi"
__all__ = ["LikeStatus", "OAuthCredentials", "YTMusic", "setup", "setup_oauth"]
