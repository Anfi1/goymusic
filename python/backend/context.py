"""Per-request capabilities shared by desktop and Android command handlers."""
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class CommandContext:
    call_id: Any
    write: Callable[[dict], None]
    get_api: Callable
    get_yandex_client: Callable
    is_cancelled: Callable[[], bool]

    def emit(self, message):
        """Tag every reply and intermediate event before the shared cancellation check."""
        message['callId'] = self.call_id
        self.write(message)
